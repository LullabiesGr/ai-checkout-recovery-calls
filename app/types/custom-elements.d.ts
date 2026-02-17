// app/types/custom-elements.d.ts
export {};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      // Allow Polaris/App Bridge custom elements without TSX errors
      [elemName: string]: any;
    }
  }
}
