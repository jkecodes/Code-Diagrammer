// The diagram panel's markup. No vscode import: the panel and the webview tests share it.

export const BODY_HTML = `
<div id="toolbar">
  <span id="title"></span>
  <span class="segmented" role="group" aria-label="What the diagram shows">
    <button id="viewFile" class="secondary" aria-pressed="true" title="The model of the file you are editing">File</button>
    <button id="viewProject" class="secondary" aria-pressed="false" title="Every main model of the project in one diagram">Project</button>
  </span>
  <button id="locate" class="secondary" hidden title="Zoom to the blocks defined in the file you are editing">Locate</button>
  <span class="segmented" role="group" aria-label="Level of detail">
    <button id="viewCode" class="secondary" aria-pressed="true" title="Every block as it is written in the code">Blocks</button>
    <button id="viewPaper" class="secondary" aria-pressed="false" title="Blocks grouped into named stages by the language model">Stages</button>
  </span>
  <button id="regroup" class="secondary" title="Ask the language model to group the blocks again" aria-label="Regenerate the stages">↻</button>
  <span id="busy" aria-live="polite"></span>
  <label><input type="checkbox" id="showShapeOps"> Show reshape ops</label>
  <button id="fit" class="secondary">Fit</button>
  <button id="trace">Trace Shapes</button>
</div>
<div id="notice" class="notice" hidden></div>
<div id="main">
  <svg id="diagram" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Model architecture diagram"></svg>
  <aside id="details"></aside>
</div>
<div id="menu" hidden></div>`;
