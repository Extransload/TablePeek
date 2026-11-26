// The selected text's background in every CodeMirror view, in the colour
// Settings → Appearance → Syntax colours → Selection sets per theme
// (--text-selection), paler while the editor isn't focused. The focused rule
// repeats the structure of CodeMirror's own default (#233 on dark, #d7d4f0 on
// light) so it is as specific and, coming later, wins over it.
export const SELECTION_STYLES = {
  ".cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--text-selection) 55%, transparent)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-content ::selection": {
    backgroundColor: "var(--text-selection)",
  },
};
