import time
from asyncio import Task, gather
from enum import Enum, auto
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from email.utils import parsedate
import datetime

import aiofiles
from simplechrome import Frame, FrameManager, NavigationError, NetworkManager, Response

from autobrowser.automation import CloseReason
from autobrowser.frontier import RedisFrontier
from autobrowser.util import Helper
from .basetab import BaseTab

__all__ = ["CrawlerTab"]


class NavigationResult(Enum):
    """An enumeration representing the three possible outcomes of navigation"""

    EXIT_CRAWL_LOOP = auto()
    OK = auto()
    SKIP_URL = auto()


class CrawlerTab(BaseTab):
    """Crawling specific tab.

    Env vars:
         - CRAWL_NO_NETCACHE: if present the network cache is disabled
         - WAIT_FOR_Q: if present the crawler will wait for the frontier q
            to be populated before starting the crawl loop.
         - BEHAVIOR_RUN_TIME: an integer, that if present, will be used
           to set the maximum amount of time the behaviors action will
           be run for (in seconds). If not present the default time
           is 60 seconds
         - OUTLINKS_EXPRESSION: the JS expression to be used for collecting outlinks
         - CLEAR_OUTLINKS_EXPRESSION: the JS expression to be used for clearing the
           collected outlinks
    """

    __slots__ = [
        "collect_outlinks_expression",
        "clear_outlinks_expression",
        "frames",
        "network",
        "crawl_loop_task",
        "frontier",
        "href_fn",
        "_max_behavior_time",
        "_navigation_timeout",
        "_exit_crawl_loop",
    ]

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.href_fn: str = "function () { return this.href; }"
        #: The variable name for the outlinks discovered by running the behavior
        self.collect_outlinks_expression: str = self.config.outlinks_expression
        self.clear_outlinks_expression: str = self.config.clear_outlinks_expression
        #: The frame manager for the page
        self.frames: FrameManager = None
        self.network: NetworkManager = None
        #: The crawling main loop
        self.crawl_loop_task: Optional[Task] = None
        self.frontier: RedisFrontier = RedisFrontier(
            self.redis, config=self.config, loop=self.loop
        )
        #: The maximum amount of time the crawler should run behaviors for
        self._max_behavior_time: Union[int, float] = self.config.max_behavior_time
        self._navigation_timeout: Union[int, float] = self.config.navigation_timeout
        self._exit_crawl_loop: bool = False

    @classmethod
    def create(cls, *args, **kwargs) -> "CrawlerTab":
        return cls(*args, **kwargs)

    @property
    def main_frame(self) -> Frame:
        """Returns a reference to the current main frame (top) of the tab

        :return: The main frame of the tab
        """
        return self.frames.mainFrame

    def main_frame_getter(self) -> Frame:
        """Helper function for behaviors that returns the current main frame
        of the tab

        :return: The main frame of the tab
        """
        return self.frames.mainFrame

    async def collect_outlinks(self, all_frames: bool = False) -> None:
        """Retrieves the outlinks collected by the running behaviors and adds them to the frontier

        :param all_frames: Flag indicating if outlinks should be collected using the CDP as
        well as gathering the ones collected by the behavior
        """
        logged_method = "collect_outlinks"
        # if all_frames:
        #     try:
        #         await self.collect_outlinks_all_frames()
        #     except Exception as e:
        #         self.logger.exception(
        #             logged_method, "manual collection failed", exc_info=e
        #         )
        #     else:
        #         self.logger.debug(logged_method, "manual out link collection succeeded")

        out_links = None
        try:
            out_links = await self.evaluate_in_page(self.collect_outlinks_expression)
        except Exception as e:
            self.logger.exception(
                logged_method,
                "gathering behavior collected out links failed",
                exc_info=e,
            )
        else:
            self.logger.debug(
                logged_method, "gathering behavior collected out links succeeded"
            )

        if out_links is not None:
            try:
                await self.frontier.add_all(out_links)
            except Exception as e:
                self.logger.exception(
                    logged_method, "frontier add_all threw an exception", exc_info=e
                )

        try:
            await self.evaluate_in_page(self.clear_outlinks_expression)
        except Exception as e:
            self.logger.exception(
                logged_method,
                "evaluating clear_outlinks threw an exception",
                exc_info=e,
            )

    async def collect_outlinks_all_frames(self) -> None:
        """Manually collects out links (a[href], area[href]) from all (i)frames in the current page"""
        logged_method = "collect_outlinks_all_frames"
        self.logger.debug(logged_method, "collecting")
        try:
            await self.client.DOM.enable()
        except Exception as e:
            self.logger.exception(
                logged_method, "failed to enabled the DOM domain", exc_info=e
            )
            return

        out_links: List[str] = []
        promises = []
        add_extraction_promise = promises.append
        extract_href_from_remote_node = self._extract_href_from_remote_node

        # we accumulate a list of extraction promises rather than awaiting each
        # extraction sequentially because asyncio.gather runs the accumulated
        # promises concurrently allowing us to efficiently extract the href
        # value of the a or area nodes contained in every (i)frame of the page
        nodes = await self.client.DOM.getFlattenedDocument(depth=-1, pierce=True)
        for node in nodes["nodes"]:
            node_name = node["localName"]
            if node_name == "a" or node_name == "area":
                add_extraction_promise(extract_href_from_remote_node(node, out_links))
        if promises:
            await gather(*promises, loop=self.loop, return_exceptions=True)
        try:
            await self.client.DOM.disable()
        except Exception as e:
            self.logger.exception(
                logged_method, "failed to disable the DOM domain", exc_info=e
            )
        if out_links:
            await self.frontier.add_all(out_links)

    async def crawl(self) -> None:
        """Starts the crawl loop.

        If the crawl loop exits and the exit was not due to graceful shutdown
        the close method is called.
        """
        logged_method = "crawl"
        frontier_exhausted = await self.frontier.exhausted()
        self.logger.info(
            logged_method,
            f"crawl loop starting and the frontier is {'exhausted' if frontier_exhausted else 'not exhausted'}",
        )

        if not frontier_exhausted:
            await self._crawl_loop()

        self.logger.info(logged_method, "crawl is finished")

        if not self._graceful_shutdown:
            await self.close()

    async def close(self) -> None:
        logged_method = "close"
        self.logger.info(
            logged_method, f"closing {'gracefully' if self._graceful_shutdown else ''}"
        )
        hard_close = not self._graceful_shutdown

        if self._running_behavior is not None and hard_close:
            self.logger.info(logged_method, "ending the running behavior")
            self._running_behavior.end()

        if self._crawl_loop_running():
            msg = (
                "canceling the crawl loop task"
                if hard_close
                else "waiting for the crawl loop task to end gracefully"
            )
            self.logger.info(logged_method, msg)
            try:
                if hard_close:
                    await Helper.timed_future_completion(
                        self.crawl_loop_task,
                        timeout=15,
                        cancel=hard_close,
                        loop=self.loop,
                    )
                else:
                    await self.crawl_loop_task
            except Exception as e:
                self.logger.exception(
                    logged_method,
                    "the crawl loop threw an unexpected exception while waiting for it to end",
                    exc_info=e,
                )

        end_info = Helper.json_string(id=self.reqid, time=int(time.time()))
        self.logger.info(logged_method, f"crawl loop task ended - {end_info}")

        if self._graceful_shutdown:
            await self.frontier.remove_current_from_pending()

        await self.navigation_reset()
        self.crawl_loop_task = None

        is_frontier_exhausted = await self.frontier.exhausted()
        if self._close_reason is None and is_frontier_exhausted:
            self._close_reason = CloseReason.CRAWL_END

        await self.redis.lpush(self.config.redis_keys.auto_done, end_info)
        await super().close()

    def set_timestamp_from_response(self, response: Response) -> None:
        """Sets the 14-digit timestamp for the specified response
        by parsing the Memento-Datetime header, if any.
        If no memento header present, use the current UTC time
        time as the timestamp

        :param response: The Response object to parse
        """

        memento_dt = None
        dt = None

        if response and response.headers:
            memento_dt = response.headers.get('Memento-Datetime')

            if memento_dt:
                try:
                    dt = datetime.datetime(*parsedate(memento_dt)[:6])
                except Exception as e:
                    pass

        if not dt:
            dt = datetime.datetime.utcnow()

        self._timestamp = dt.strftime('%Y%m%d%H%M%S')

    async def goto(
        self, url: str, wait: str = "load", *args: Any, **kwargs: Any
    ) -> NavigationResult:
        """Navigate the browser to the supplied URL. The return value
        of this function indicates the next action to be performed by the crawler

        :param url: The URL of the page to navigate to
        :param wait: The wait condition that all the pages frame have
        before navigation is considered complete
        :param kwargs: Any additional arguments for use in navigating
        :return: An NavigationResult indicating the next action of the crawler
        """
        self._url = url
        logged_method = f"goto"
        try:
            response = await self.frames.mainFrame.goto(
                url, waitUntil=wait, timeout=self._navigation_timeout
            )
            self.set_timestamp_from_response(response)
            info = (
                Helper.json_string(
                    url=url,
                    responseURL=response.url,
                    status=response.status,
                    mime=response.mimeType,
                )
                if response is not None
                else Helper.json_string(url=url)
            )
            self.logger.info(logged_method, f"we navigated to the page - {info}")
            self.frontier.crawling_new_page(self.main_frame.url)
            return self._determine_navigation_result(response)
        except NavigationError as ne:
            if ne.disconnected:
                self.logger.critical(
                    logged_method,
                    f"connection closed while navigating to {url}",
                    exc_info=ne,
                )
                return NavigationResult.EXIT_CRAWL_LOOP
            if ne.timeout or ne.response is not None:
                return self._determine_navigation_result(ne.response)
            self.logger.exception(
                logged_method, f"navigation failed for {url}", exc_info=ne
            )
            return NavigationResult.SKIP_URL
        except Exception as e:
            self.logger.exception(
                logged_method, f"unknown error while navigating to {url}", exc_info=e
            )
            return NavigationResult.EXIT_CRAWL_LOOP

    async def init(self) -> None:
        """Initialize the crawler tab, if the crawler tab is already running this is a no op."""
        if self._running:
            return
        logged_method = "init"
        self.logger.info(logged_method, "initializing")
        # must call super init
        await super().init()
        if self.config.net_cache_disabled:
            await self.client.Network.setCacheDisabled(True)
        # enable receiving of frame lifecycle events for the frame manager
        await self.client.Page.setLifecycleEventsEnabled(True)
        self.network = NetworkManager(self.client, loop=self.loop)
        frame_tree = await self.client.Page.getFrameTree()
        self.frames = FrameManager(
            self.client,
            networkManager=self.network,
            isolateWorlds=False,
            loop=self.loop,
            frameTree=frame_tree["frameTree"],
        )
        self.network.setFrameManager(self.frames)
        self.frames.setDefaultNavigationTimeout(self._navigation_timeout)
        # ensure we do not have any naughty JS by disabling its ability to
        # prevent us from navigating away from the page
        await self._load_utility_js()
        empty_frontier = await self.frontier.init()
        if empty_frontier:
            specifics = (
                "we waited for it become populated"
                if self.frontier.did_wait
                else "we were not configured to wait"
            )
            self.logger.info(
                logged_method,
                f"the frontier is empty and {specifics}, we will be exiting",
            )
        self.crawl_loop_task = self.loop.create_task(self.crawl())
        self.logger.info(logged_method, "initialized")
        await Helper.one_tick_sleep()

    async def navigation_reset(self) -> None:
        logged_method = "navigation_reset"
        if self.client.closed:
            self.logger.critical(
                logged_method, "Cannot reset tab to about:blank, connection closed"
            )
            return
        self.logger.info(logged_method, "Resetting tab to about:blank")
        try:
            await self.frames.mainFrame.goto("about:blank", wait="documentloaded")
        except Exception as e:
            self.logger.exception(
                logged_method, "Resetting the tab to about:blank failed", exc_info=e
            )
        else:
            self.logger.info(logged_method, "tab reset to about:blank")

    async def run_behavior(self) -> None:
        """Retrieves the behavior for the page the crawler is currently at and runs it.

        If this method is called and the crawler is to exit the crawl loop this method becomes a no op.

        If the crawler is configured to run behaviors until a configured maximum time, the time_run
        method of autobrowser.behaviors.runners.WRBehaviorRunner is used otherwise run.
        """
        if self._should_exit_crawl_loop():
            return
        logged_method = "run_behavior"
        # use self.frame_manager.mainFrame.url because it is the fully resolved URL that the browser displays
        # after any redirects happen
        self._url = self.main_frame.url
        behavior = await self.behavior_manager.behavior_for_url(
            self.main_frame.url,
            self,
            collect_outlinks=True,
            post_run_actions=self.config.require_post_behavior_actions,
        )
        self.logger.debug(logged_method, f"running behavior {behavior}")
        # we have a behavior to be run so run it
        if behavior is not None:
            # run the behavior in a timed fashion (async_timeout will cancel the corutine if max time is reached)
            try:
                if self._max_behavior_time != -1:
                    self.logger.debug(
                        logged_method,
                        f"running the behavior timed <time={self._max_behavior_time}>",
                    )
                    await behavior.timed_run(self._max_behavior_time)
                else:
                    await behavior.run()
            except Exception as e:
                self.logger.exception(
                    logged_method,
                    "while running the behavior it raised an error",
                    exc_info=e,
                )
        # perform any actions that we are configured to do after the behavior has run
        await self._post_run_behavior()

    async def _handle_navigation_result(
        self, url: str, navigation_result: NavigationResult
    ) -> None:
        """Performs the next crawler action based on the supplied navigation results.

        Actions:
           - `EXIT_CRAWL_LOOP`: log and set the `_exit_crawl_loop` to True
           - `SKIP_URL`: log
           - `OK`: log and run the page's behavior

        The currently crawled URL is always updated in redis no matter what
        the navigation result is.

        :param url: The URL of the page navigated to
        :param navigation_result: The results of the navigation
        """
        logged_method = "_handle_navigation_result"
        if navigation_result == NavigationResult.OK:
            self.logger.info(
                logged_method, f"navigated to the next URL with no error - {url}"
            )
            await self.run_behavior()

        elif navigation_result == NavigationResult.EXIT_CRAWL_LOOP:
            self.logger.critical(
                logged_method,
                f"exiting crawl loop due to fatal navigation error - {url}",
            )
            self._exit_crawl_loop = True

        elif navigation_result == NavigationResult.SKIP_URL:
            self.logger.info(
                logged_method, f"the URL navigated to is being skipped - {url}"
            )

        # we remove from pending set when we run a behavior
        await self.frontier.remove_current_from_pending()

    def _crawl_loop_running(self) -> bool:
        """Returns T/F indicating if the crawl loop is running (task not done)

        :return: T/F indicating if crawl loop is running
        """
        return self.crawl_loop_task is not None and not self.crawl_loop_task.done()

    def _determine_navigation_result(
        self, navigation_response: Optional[Response]
    ) -> NavigationResult:
        """Returns the NavigationResult based on the supplied navigation response

        :param navigation_response: The navigation response if one was sent
        :return: The NavigationResult based on the navigation response
        """
        logged_method = "_determine_navigation_result"
        if navigation_response is None:
            self.logger.info(
                logged_method,
                f"we navigated somewhere but must skip the URL due to not having a navigation response",
            )
            return NavigationResult.SKIP_URL
        if "html" in navigation_response.mimeType.lower():
            if navigation_response.ok:
                return NavigationResult.OK
            self.logger.info(
                logged_method,
                f"we navigated to a page but the status was not OK - {navigation_response.status}",
            )
            return NavigationResult.SKIP_URL
        self.logger.info(
            logged_method,
            f"we navigated to a non-page - mime={navigation_response.mimeType}, status={navigation_response.status}",
        )
        return NavigationResult.SKIP_URL

    async def _crawl_loop(self) -> None:
        """The primary crawl logic / loop.

         For each URL in the frontier:
          - navigate to the page
          - perform the next crawler action based on the navigation results
          - if there was inner page links visit them before navigating to the next page

         The crawl loop is exited once the frontier becomes exhausted or one of the following conditions are met:
           - shutdown, graceful or otherwise, is initiated
           - the connection to the tab is closed
           - navigation to a page fails for unknown reasons
           - the frontier becomes exhausted
        """
        logged_method = "_crawl_loop"
        should_exit_crawl_loop = self._should_exit_crawl_loop
        next_crawl_url = self.frontier.next_url
        navigate_to_page = self.goto
        is_frontier_exhausted = self.frontier.exhausted
        log_info = self.logger.info
        handle_navigation_result = self._handle_navigation_result
        one_tick_sleep = Helper.one_tick_sleep

        # loop until frontier is exhausted or we should exit crawl loop
        while 1:
            if should_exit_crawl_loop():
                log_info(
                    logged_method, "exiting crawl loop before crawling the next url"
                )
                break

            next_url = await next_crawl_url()

            log_info(logged_method, f"navigating - {next_url}")

            navigation_result = await navigate_to_page(next_url)

            await handle_navigation_result(next_url, navigation_result)

            frontier_exhausted = await is_frontier_exhausted()

            if frontier_exhausted or should_exit_crawl_loop():
                log_info(
                    logged_method,
                    f"exiting crawl loop after crawling the next url - frontier exhausted = {frontier_exhausted}",
                )
                break

            # we sleep for one event loop tick in order to ensure that other
            # coroutines can do their thing if they are waiting. e.g. shutdowns etc
            await one_tick_sleep()

    async def _post_run_behavior(self) -> None:
        """Performs the actions the crawler is configured to perform once a behavior has run"""
        await self._visit_inner_page_links()

    async def _visit_inner_page_links(self) -> None:
        """Visits any inner page links that may have been collected for the current page"""
        logged_method = "_visit_inner_page_links"
        have_ipls = False
        next_ipl = self.frontier.pop_inner_page_link
        goto_ipl = self.frames.mainFrame.goto
        log = self.logger.debug
        wait = "load"
        try:
            have_ipls = await self.frontier.have_inner_page_links()
            if have_ipls:
                log(logged_method, f"visiting inner page links")
                while 1:
                    ipl = await next_ipl()
                    if ipl is None:
                        break
                    log(logged_method, f"visiting - {ipl}")
                    await goto_ipl(ipl, wait=wait)
            if have_ipls:
                await self.frontier.remove_inner_page_links()
        except Exception as e:
            msg = (
                "failed to visit all inner page links due to an exception"
                if have_ipls
                else "attempted to visit all inner page links but an exception occurred"
            )
            self.logger.exception(logged_method, msg, exc_info=e)

    async def _extract_href_from_remote_node(
        self, node: Dict, outlink_accum: List[str]
    ) -> None:
        """Converts the supplied node to it's runtime object and retrieves the value of
        calling the href property getting on the node, adding the value of the href
        to the supplied out link accumulator if it has a crawlable scheme e.g. http(s)

        :param node: A node dict returned by DOM.getFlattenedDocument
        :param outlink_accum: A list used to accumulate valid out links
        """
        # the supplied node dictionary represents the dom node as is
        # i.e. any attributes listed in that dictionary are not resolved
        # according to the browser's attribute resolution algorithm
        # hence the need to resolve (convert the node to a runtime DOM object)
        # and call the node's getter for the href attribute
        runtime_node = await self.client.DOM.resolveNode(nodeId=node["nodeId"])
        obj_id = runtime_node["object"]["objectId"]
        results = await self.client.Runtime.callFunctionOn(
            self.href_fn, objectId=obj_id
        )
        await self.client.Runtime.releaseObject(objectId=obj_id)
        # the url here is fully resolved against the origin it exists in
        # thus safe for usage in programmatic navigation
        url = results.get("result", {}).get("value")
        if Helper.url_has_crawlable_scheme(url):
            outlink_accum.append(url)

    async def _load_utility_js(self) -> None:
        """Loads and adds utility JS files found in autobrowser/tabs/js
        to the set of scripts the browser will evaluate on every new
        document before evaluating any of the documents own scripts.

        Script list
          - nice.js: ensures that the browser can not be trapped by prompts et. al.
          - notTopMiniBehavior.js: an mini-behavior for child frames that handles
            soundcloud, youtube, and vimeo embeds or scrolls frame playing audio/video
            tags
          - notABot.js: ensures, to the best of our ability, that we will not
            be finger printed as a bot
        """
        js_dir = Path(__file__).parent / "js"
        for js_file in ["nice.js", "notTopMiniBehavior.js", "notABot.js"]:
            async with aiofiles.open(str(js_dir / js_file), "r") as iin:
                await self.client.Page.addScriptToEvaluateOnNewDocument(await iin.read())

    def _should_exit_crawl_loop(self) -> bool:
        """Returns T/F indicating if the crawl loop should be exited based on if
        graceful shutdown was initiated, or the connection to the tab was closed,
        if the exit crawl loop property is set to true

        :return: T/F indicating if the crawl loop should be exited
        """
        return (
            self._graceful_shutdown or self.connection_closed or self._exit_crawl_loop
        )
