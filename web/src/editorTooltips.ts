import { tooltips } from "@codemirror/view";

// CodeMirror draws an editor's tooltips (the completion list and its info
// panel, hover and lint popups) inside the editor, whose overflow cuts them
// off at its edge: in the desktop app (WebKit) the list's drop-in motion makes
// CodeMirror place them absolutely, so a list near the bottom of the editor
// vanished under the toolbar. Drawn in this layer at the end of the page
// instead, they float above everything as the app's other popovers do.
const layer = document.createElement("div");
layer.className = "cm-float-layer";
document.body.appendChild(layer);

export const floatingTooltips = tooltips({ parent: layer });
