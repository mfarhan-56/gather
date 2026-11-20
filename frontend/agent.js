// AETHER Agent: real app actions (Composio integration).
// Owned by the agent/Composio work; uses only the public window.AETHER API from app.js
// and the "aether:agent-rendered" event fired when the agent window shows results.
(() => {
  if (!window.AETHER) return;
  document.addEventListener("aether:agent-rendered", (e) => {
    // Composio action buttons will be attached here.
  });
})();
