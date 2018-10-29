(function runner(xpg, debug) {
  /**
   * @param {string} xpathQuery
   * @param {Element | Document} startElem
   * @return {XPathResult}
   */

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

  let reactProps = {
    rootContainer: '_reactRootContainer',
    internalRoot: '_internalRoot',
    onDomNode: '__reactInternalInstance',
    rootHostElemId: 'react-root',
    mProps: 'memoizedProps'
  };

  /**
   * @param {HTMLElement | Element | Node} elem
   * @return {Object}
   */
  function reactInstanceFromDOMElem(elem) {
    const keys = Object.keys(elem);
    let i = 0;
    let len = keys.length;
    let internalKey;
    for (; i < len; ++i) {
      if (keys[i].startsWith(reactProps.onDomNode)) {
        internalKey = keys[i];
        break;
      }
    }
    if (!internalKey) throw new Error('Could not find react internal key');
    return elem[internalKey];
  }

  /**
   * @param {Array<Node | HTMLElement | Element>} elems
   * @param {function(key: string): boolean} selectingFn
   * @return {Array<{node: HTMLElement | Element | Node, reactInstance: Object}>}
   */
  function reactInstancesFromElements(elems, selectingFn) {
    const renderedNodes = [];
    const length = elems.length;
    let i = 0;
    let node;
    let reactInstance;
    for (; i < length; ++i) {
      node = elems[i];
      reactInstance = reactInstanceFromDOMElem(node);
      if (selectingFn(reactInstance.key)) {
        renderedNodes.push({ node, reactInstance });
      }
    }
    return renderedNodes;
  }

  class OutLinkCollector {
    constructor() {
      /**
       * @type {Set<string>}
       */
      this.outlinks = new Set();
      this.ignored = [
        'about:',
        'data:',
        'mailto:',
        'javascript:',
        'js:',
        '{',
        '*',
        'ftp:',
        'tel:'
      ];
      this.good = { 'http:': true, 'https:': true };
      this.urlParer = new URL('about:blank');
      this.outlinkSelector = 'a[href], area[href]';
    }

    shouldIgnore(test) {
      let ignored = false;
      let i = this.ignored.length;
      while (i--) {
        if (test.startsWith(this.ignored[i])) {
          ignored = true;
          break;
        }
      }
      if (!ignored) {
        let parsed = true;
        try {
          this.urlParer.href = test;
        } catch (error) {
          parsed = false;
        }
        return !(parsed && this.good[this.urlParer.protocol]);
      }
      return ignored;
    }

    collectFromDoc() {
      this.addOutLinks(document.querySelectorAll(this.outlinkSelector));
    }

    collectFrom(queryFrom) {
      this.addOutLinks(queryFrom.querySelectorAll(this.outlinkSelector));
    }

    addOutLinks(outlinks) {
      let href;
      let i = outlinks.length;
      while (i--) {
        href = outlinks[i].href.trim();
        if (href && !this.outlinks.has(href) && !this.shouldIgnore(href)) {
          this.outlinks.add(href);
        }
      }
    }

    /**
     * @param {HTMLAnchorElement|HTMLAreaElement|string} elemOrString
     */
    addOutlink(elemOrString) {
      const href = (elemOrString.href || elemOrString).trim();
      if (href && !this.outlinks.has(href) && !this.shouldIgnore(href)) {
        this.outlinks.add(href);
      }
    }

    /**
     * @return {string[]}
     */
    outLinkArray() {
      return Array.from(this.outlinks);
    }

    /**
     * @return {string[]}
     */
    toJSON() {
      return this.outLinkArray();
    }

    /**
     * @return {string[]}
     */
    valueOf() {
      return this.outLinkArray();
    }
  }

  const OLC = new OutLinkCollector();

  Object.defineProperty(window, '$wbOutlinks$', {
    value: OLC,
    writable: false,
    enumerable: false
  });

  addBehaviorStyle('.wr-debug-visited {border: 6px solid #3232F1;}');

  async function* consumePins(renderedPins) {
    let pin;
    let i = 0;
    let numPins = renderedPins.length;
    for (; i < numPins; ++i) {
      // scroll post row into view
      pin = renderedPins[i];
      OLC.collectFrom(pin.node);
      await scrollIntoViewWithDelay(pin.node);
      // pin.node.classList.add('wr-debug-visited');
      yield pin.node;
    }
  }

  const selectors = {
    gridImage: 'div[data-grid-item]',
    gridContainer: 'div.gridCentered > div > div > div'
  };

  function getGridContainer() {
    const firstChild = document.querySelector(selectors.gridImage);
    const container = firstChild.parentElement;
    if (container !== document.querySelector(selectors.gridContainer)) {
      throw new Error('wrong container');
    }
    return container;
  }

  async function* iteratePins(xpathGenerator) {
    const seenPins = new Set();
    const pinContainerR = reactInstanceFromDOMElem(getGridContainer());
    const keySelector = key => {
      const select = !seenPins.has(key);
      if (select) {
        seenPins.add(key);
      }
      return select;
    };
    const getRenderedPins = () =>
      reactInstancesFromElements(
        pinContainerR.stateNode.childNodes,
        keySelector
      );
    let currentPostRows = getRenderedPins();
    // consume rows until all posts have been loaded
    do {
      yield* consumePins(currentPostRows);
      currentPostRows = getRenderedPins();
    } while (currentPostRows.length > 0);
    // finish consuming the rows until we are done
    if (currentPostRows.length === 0) {
      currentPostRows = getRenderedPins();
    }
    do {
      yield* consumePins(currentPostRows);
      currentPostRows = getRenderedPins();
    } while (currentPostRows.length > 0);
  }

  window.$WRIterator$ = iteratePins(maybePolyfillXPG(xpg));
  window.$WRIteratorHandler$ = async function() {
    const next = await $WRIterator$.next();
    return next.done;
  };
})($x, false);
