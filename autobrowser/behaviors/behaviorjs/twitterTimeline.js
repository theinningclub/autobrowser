(function runner(xpg, debug) {
  /**
   * @param {string} xpathQuery
   * @param {Element | Document} startElem
   * @return {XPathResult}
   */
  function xpathSnapShot(xpathQuery, startElem) {
    if (startElem == null) {
      startElem = document;
    }
    return document.evaluate(
      xpathQuery,
      startElem,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
  }

  /**
   * @param {function(string, ?HTMLElement | ?Document)} cliXPG
   * @return {function(string, ): Array<HTMLElement>}
   */
  function maybePolyfillXPG(cliXPG) {
    if (
      typeof cliXPG !== 'function' ||
      cliXPG.toString().indexOf('[Command Line API]') === -1
    ) {
      return function(xpathQuery, startElem) {
        if (startElem == null) {
          startElem = document;
        }
        const snapShot = document.evaluate(
          xpathQuery,
          startElem,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        );
        const elements = [];
        let i = 0;
        let len = snapShot.snapshotLength;
        while (i < len) {
          elements.push(snapShot.snapshotItem(i));
          i += 1;
        }
        return elements;
      };
    }
    return cliXPG;
  }

  /**
   * @param {HTMLElement | Element | Node} elem
   * @param {string} [marker = 'wrvistited']
   */
  function markElemAsVisited(elem, marker = 'wrvistited') {
    if (elem != null) {
      elem.classList.add(marker);
    }
  }

  function addBehaviorStyle(styleDef) {
    if (document.getElementById('$wrStyle$') == null) {
      const style = document.createElement('style');
      style.id = '$wrStyle$';
      style.textContent = styleDef;
      document.head.appendChild(style);
    }
  }

  /**
   * @param {number} [delayTime = 3000]
   * @returns {Promise<void>}
   */
  function delay(delayTime = 3000) {
    return new Promise(resolve => {
      setTimeout(resolve, delayTime);
    });
  }

  /**
   * @desc Returns a promise that resolves when the supplied predicate function
   * returns a truthy value. Polling via setInterval 1sec.
   * @param {function(): boolean} predicate
   * @return {Promise<void>}
   */
  function waitForPredicate(predicate) {
    return new Promise(resolve => {
      let int = setInterval(() => {
        if (predicate()) {
          clearInterval(int);
          resolve();
        }
      }, 1000);
    });
  }

  /**
   * @param {Element | HTMLElement | Node} elem - The element to be scrolled into view
   */
  function scrollIntoView(elem) {
    if (elem == null) return;
    elem.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'center'
    });
  }

  /**
   * @param {Element | HTMLElement | Node} elem - The element to be scrolled into view with delay
   * @param {number} [delayTime = 1000] - How long is the delay
   * @returns {Promise<void>}
   */
  function scrollIntoViewWithDelay(elem, delayTime = 1000) {
    scrollIntoView(elem);
    return delay(delayTime);
  }

  /**
   * @desc Determines if we can scroll any more
   * @return {boolean}
   */
  function canScrollMore() {
    return (
      window.scrollY + window.innerHeight <
      Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.clientHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight
      )
    );
  }

  /**
   * @desc Calls the click function on the supplied element if non-null/defined.
   * Returns true or false to indicate if the click happened
   * @param {HTMLElement | Element | Node} elem - The element to be clicked
   * @return {boolean}
   */
  function click(elem) {
    let clicked = false;
    if (elem != null) {
      elem.dispatchEvent(
        new window.MouseEvent('mouseover', {
          view: window,
          bubbles: true,
          cancelable: true
        })
      );
      elem.click();
      clicked = true;
    }
    return clicked;
  }

  /**
   * @param {Element | Node | HTMLElement} selectFrom - element to use for the querySelector call
   * @param {string} selector - the css selector to use
   * @returns {boolean}
   */
  function selectElemFromAndClick(selectFrom, selector) {
    return click(selectFrom.querySelector(selector));
  }

  /**
   * @param {Element | Node | HTMLElement} elem - the element to be clicked
   * @param {function(): boolean} predicate - function returning true or false indicating the wait condition is satisfied
   * @returns {Promise<boolean>}
   */
  async function clickAndWaitFor(elem, predicate) {
    const clicked = click(elem);
    if (clicked) {
      await waitForPredicate(predicate);
    }
    return clicked;
  }

  if (typeof window.$wbOutlinkSet$ === 'undefined') {
    Object.defineProperty(window, '$wbOutlinkSet$', {
      value: new Set(),
      enumerable: false
    });
  } else {
    window.$wbOutlinkSet$.clear();
  }

  if (typeof window.$wbOutlinks$ === 'undefined') {
    Object.defineProperty(window, '$wbOutlinks$', {
      get() {
        return Array.from(window.$wbOutlinkSet$);
      },
      set() {},
      enumerable: false
    });
  }

  const outlinks = window.$wbOutlinkSet$;
  const goodSchemes = { 'http:': true, 'https:': true };
  const outLinkURLParser = new URL('about:blank');
  const outlinkSelector = 'a[href], area[href]';

  function shouldIgnoreLink(test) {
    let ignored = false;
    let i = ignored.length;
    while (i--) {
      if (test.startsWith(ignored[i])) {
        ignored = true;
        break;
      }
    }
    if (!ignored) {
      let parsed = true;
      try {
        outLinkURLParser.href = test;
      } catch (error) {
        parsed = false;
      }
      return !(parsed && goodSchemes[outLinkURLParser.protocol]);
    }
    return ignored;
  }

  function addOutLinks(toAdd) {
    let href;
    let i = toAdd.length;
    while (i--) {
      href = toAdd[i].href.trim();
      if (href && !outlinks.has(href) && !shouldIgnoreLink(href)) {
        outlinks.add(href);
      }
    }
  }

  function collectOutlinksFrom(queryFrom) {
    addOutLinks(queryFrom.querySelectorAll(outlinkSelector));
  }

  /**
   * @desc Xpath query used to traverse each tweet within a timeline.
   *
   * During visiting tweets, the tweets are marked as visited by adding the
   * sentinel`$wrvisited$` to the classList of a tweet seen during timeline traversal,
   * normal usage of a CSS selector and `document.querySelectorAll` is impossible
   * unless significant effort is made in order to ensure each tweet is seen only
   * once during timeline traversal.
   *
   * Tweets in a timeline have the following structure:
   *  div.tweet.js-stream-tweet.js-actionable-tweet.js-profile-popup-actionable.dismissible-content...
   *    |- div.content
   *       |- ...
   *  div.tweet.js-stream-tweet.js-actionable-tweet.js-profile-popup-actionable.dismissible-content...
   *   |- div.content
   *      |- ...
   *
   * We care only about the minimal identifiable markers of a tweet:
   *  div.tweet.js-stream-tweet...
   *   |- div.content
   *
   * such that when a tweet is visited during timeline traversal it becomes:
   *  div.tweet.js-stream-tweet...
   *   |- div.content.wrvistited
   *
   * which invalidates the query on subsequent evaluations against the DOM,
   * thus allowing for unique traversal of each tweet in a timeline.
   * @type {string}
   */
  const tweetXpath =
    '//div[starts-with(@class,"tweet js-stream-tweet")]/div[@class="content" and not(contains(@class, "wrvistited"))]';

  /**
   * @desc A variation of {@link tweetXpath} in that it is further constrained
   * to only search tweets within the overlay that appears when you click on
   * a tweet
   * @type {string}
   */
  const overlayTweetXpath = `//div[@id="permalink-overlay"]${tweetXpath}`;

  addBehaviorStyle(
    '.wr-debug-visited {border: 6px solid #3232F1;} .wr-debug-visited-thread-reply {border: 6px solid green;} .wr-debug-visited-overlay {border: 6px solid pink;} .wr-debug-click {border: 6px solid red;}'
  );

  /**
   * An abstraction around interacting with HTML of a tweet in a timeline.
   *
   *  Selector, element breakdown:
   *    div.tweet.js-stream-tweet... (_container)
   *     |- div.content (aTweet, _tweet)
   *         |- div.stream-item-footer (_footer)
   *             |- div.ProfileTweet-action--reply (_tRplyAct)
   *                 |- button[data-modal="ProfileTweet-reply"] (_rplyButton)
   *                     |- span.ProfileTweet-actionCount--isZero (IFF no replied)
   *    |- div.self-thread-tweet-cta
   *        |- a.js-nav.show-thread-link
   */
  const tweetFooterSelector = 'div.stream-item-footer';
  const replyActionSelector = 'div.ProfileTweet-action--reply';
  const noReplySpanSelector = 'span.ProfileTweet-actionCount--isZero';
  const replyBtnSelector = 'button[data-modal="ProfileTweet-reply"]';
  const closeFullTweetSelector = 'div.PermalinkProfile-dismiss > span';
  const threadSelector = 'a.js-nav.show-thread-link';

  class Tweet {
    /**
     *
     * @param {HTMLElement} aTweet - The content div for a tweet in a timeline
     * @param {string} baseURI - The document.baseURI of the timeline page being viewed
     */
    constructor(aTweet, baseURI) {
      markElemAsVisited(aTweet);
      this.tweet = aTweet;
      this.container = aTweet.parentElement;
      this.dataset = this.container.dataset;
      this.footer = this.tweet.querySelector(tweetFooterSelector);
      this.tRplyAct = this.footer.querySelector(replyActionSelector);
      this.rplyButton = this.tRplyAct.querySelector(replyBtnSelector);

      this.fullTweetOverlay = null;

      /**
       * @desc If the currently visited tweet has replies then the span with
       * class `ProfileTweet-actionCount--isZero` must not exist
       * @type {boolean}
       * @private
       */
      this._hasReplys =
        this.rplyButton.querySelector(noReplySpanSelector) == null;
      /**
       * @desc If the currently visited tweet is apart of a thread,
       * then an a tag will be present with classes `js-nav.show-thread-link`
       * @type {boolean}
       * @private
       */
      this._apartThread = this.tweet.querySelector(threadSelector) != null;

      this._baseURI = baseURI;
    }

    hasVideo() {
      const videoContainer = this.tweet.querySelector(
        'div.AdaptiveMedia-videoContainer'
      );
      if (videoContainer != null) {
        const video = videoContainer.querySelector('video');
        if (video) {
          video.play();
        }
        return true;
      }
      return false;
    }

    tweetId() {
      return this.dataset.tweetId;
    }

    permalinkPath() {
      return this.dataset.permalinkPath;
    }

    hasReplys() {
      return this._hasReplys;
    }

    apartOfThread() {
      return this._apartThread;
    }

    hasRepliedOrInThread() {
      return this.hasReplys() || this.apartOfThread();
    }

    /**
     * @desc Clicks (views) the currently visited tweet
     * @return {AsyncIterableIterator<boolean>}
     */
    async *viewRepliesOrThread() {
      await this.openFullTweet();
      yield* this.visitThreadReplyTweets();
      await this.closeFullTweetOverlay();
    }

    /**
     * @return {AsyncIterableIterator<boolean>}
     */
    async *viewRegularTweet() {
      await this.openFullTweet();
      yield false;
      await this.closeFullTweetOverlay();
    }

    /**
     * @desc Clicks (views) the currently visited tweet
     * @return {Promise<boolean>}
     */
    openFullTweet() {
      const permalinkPath = this.permalinkPath();
      return clickAndWaitFor(this.container, () => {
        const done = document.baseURI.endsWith(permalinkPath);
        if (done) {
          this.fullTweetOverlay = document.getElementById('permalink-overlay');
          if (debug) {
            this.fullTweetOverlay.classList.add('wr-debug-visited-overlay');
          }
        }
        return done;
      });
    }

    /**
     * @return {AsyncIterableIterator<boolean>}
     */
    async *visitThreadReplyTweets() {
      collectOutlinksFrom(this.fullTweetOverlay);
      let snapShot = xpathSnapShot(overlayTweetXpath, this.fullTweetOverlay);
      let aTweet;
      let i, len;
      if (snapShot.snapshotLength === 0) return;
      do {
        len = snapShot.snapshotLength;
        i = 0;
        while (i < len) {
          aTweet = snapShot.snapshotItem(i);
          markElemAsVisited(aTweet);
          if (debug) {
            aTweet.classList.add('wr-debug-visited-thread-reply');
          }
          await scrollIntoViewWithDelay(aTweet);
          yield false;
          i += 1;
        }
        snapShot = xpathSnapShot(overlayTweetXpath, this.fullTweetOverlay);
        if (snapShot.snapshotLength === 0) {
          if (
            selectElemFromAndClick(
              this.fullTweetOverlay,
              'button.ThreadedConversation-showMoreThreadsButton'
            )
          ) {
            await delay();
          }
          snapShot = xpathSnapShot(overlayTweetXpath, this.fullTweetOverlay);
        }
      } while (snapShot.snapshotLength > 0);
    }

    /**
     * @desc Closes the overlay representing viewing a tweet
     * @return {Promise<boolean>}
     */
    closeFullTweetOverlay() {
      const overlay = document.querySelector(closeFullTweetSelector);
      if (!overlay) return Promise.resolve(false);
      if (debug) overlay.classList.add('wr-debug-click');
      return clickAndWaitFor(overlay, () => {
        const done = document.baseURI === this._baseURI;
        if (done && debug) {
          overlay.classList.remove('wr-debug-click');
        }
        return done;
      });
    }
  }

  /**
   * @desc For a more detailed explanation about the relationship between the xpath
   * query used and the marking of each tweet as visited by this algorithm see the
   * description for {@link tweetXpath}.
   *
   * (S1) Build initial set of to be visited tweets
   * (S2) For each tweet visible at current scroll position:
   *      - mark as visited
   *      - scroll into view
   *      - yield tweet
   *      - if should view full tweet (has replies or apart of thread)
   *        - yield all sub tweets
   * (S3) Once all tweets at current scroll position have been visited:
   *      - wait for Twitter to load more tweets (if any more are to be had)
   *      - if twitter added more tweets add them to the to be visited set
   * (S4) If we have more tweets to visit and can scroll more:
   *      - GOTO S2
   *
   * @param {function(string,): Array<HTMLElement>} xpathQuerySelector
   * @param {string} baseURI - The timelines documents baseURI
   * @return {AsyncIterator<boolean>}
   */
  async function* timelineIterator(xpathQuerySelector, baseURI) {
    let tweets = xpathQuerySelector(tweetXpath);
    let aTweet;
    do {
      while (tweets.length > 0) {
        aTweet = new Tweet(tweets.shift(), baseURI);
        if (debug) {
          aTweet.tweet.classList.add('wr-debug-visited');
        }
        await scrollIntoViewWithDelay(aTweet.tweet, 500);
        collectOutlinksFrom(aTweet.tweet);
        if (aTweet.hasVideo()) {
          yield true;
        }
        if (aTweet.hasRepliedOrInThread()) {
          yield* aTweet.viewRepliesOrThread();
        } else {
          yield* aTweet.viewRegularTweet();
        }
      }
      tweets = xpathQuerySelector(tweetXpath);
      if (tweets.length === 0) {
        await delay();
        tweets = xpathQuerySelector(tweetXpath);
      }
    } while (tweets.length > 0 && canScrollMore());
  }

  /**
   * @type {AsyncIterator<boolean>}
   */
  window.$WRTweetIterator$ = timelineIterator(
    maybePolyfillXPG(xpg),
    document.baseURI
  );
  window.$WRIteratorHandler$ = async function() {
    const next = await $WRTweetIterator$.next();
    return { done: next.done, wait: !!next.value };
  };
})($x, true);
