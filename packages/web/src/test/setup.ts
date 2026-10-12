import "@testing-library/jest-dom/vitest";

// jsdom has no media-query engine. Keep responsive effects in their static
// layout unless a test supplies its own matching media query implementation.
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (media: string): MediaQueryList => ({
    matches: false,
    media,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  }),
});

// jsdom has no scrolling engine. Preserve scroll coordinates for consumers
// of the browser's Element.scrollTo API without simulating layout or motion.
Object.defineProperty(Element.prototype, "scrollTo", {
  configurable: true,
  writable: true,
  value: function (
    this: Element,
    optionsOrX: ScrollToOptions | number,
    y?: number
  ) {
    if (typeof optionsOrX === "number") {
      this.scrollLeft = optionsOrX;
      this.scrollTop = y ?? 0;
    } else {
      if (optionsOrX.left !== undefined) this.scrollLeft = optionsOrX.left;
      if (optionsOrX.top !== undefined) this.scrollTop = optionsOrX.top;
    }
  },
});

// xterm probes canvas capabilities during module initialization. jsdom does
// not implement canvas, so provide the smallest test-only capability stub.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({
    fillRect: () => undefined,
    clearRect: () => undefined,
    getImageData: () => ({ data: [] }),
    putImageData: () => undefined,
    createImageData: () => [],
    setTransform: () => undefined,
    drawImage: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    translate: () => undefined,
    scale: () => undefined,
    rotate: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
    measureText: () => ({ width: 0 }),
  }),
});
