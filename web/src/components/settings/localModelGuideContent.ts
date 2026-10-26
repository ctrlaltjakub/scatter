/** Source copy for the bundled guide. After editing, regenerate its term
 * markings and previews with markTerms / completeTermPreviews; the regression
 * test rejects stale generated copy. Opening the guide never calls a model. */
export const localModelGuideSource = `### API connection

1. Select **Ollama**, **LM Studio**, or **OpenAI-compatible** for other servers and gateways. Enter the API base URL, including \`/v1\`. Defaults: Ollama \`http://localhost:11434/v1\`; LM Studio \`http://localhost:1234/v1\`.
2. The API must expose \`GET /v1/models\` and streaming \`POST /v1/chat/completions\`. Enter its **API token**; without authentication, use any nonempty value such as \`local\`.
3. **Requests go directly from the browser.** Allow the app’s origin in CORS, including \`Authorization\` and \`Content-Type\` headers. Browser local-network permissions and HTTPS/mixed-content restrictions also apply.

### Web search

In the provider’s **Search connection** field, choose the interface your server supports:

- **Server-managed · LM Studio MCP:** requires \`/api/v1/chat\`, authenticated MCP access, and **Allow calling servers from mcp.json**. Enter the configured server name without \`mcp/\`, plus exact allowed tool names.
- **Server-managed · Responses + remote MCP:** requires \`/v1/responses\` with server-executed MCP. Enter the search MCP URL reachable by that server and exact allowed tool names. No separate MCP authentication field is provided.
- **Server-managed · LocalAI:** requires Chat Completions with MCP support. Enter the search-server names already configured for the model.
- **Browser-managed · SearXNG:** enter a browser-reachable SearXNG URL with JSON results and CORS enabled. Requires model tool calling. Search requests send no credentials or cookies.

**Allow only read-only search tools.** Keep search-service credentials on the server. **Web search off** disables app-requested search, not independent search enforced by your server.

### Model selection and checks

Assign roles in **Models and generation**. Main and secondary models require vision for image tasks; interactive nodes also require vision for screenshot review, plus reliable coding. Tool calling is recommended.

If capability metadata is incomplete, use **Show all models** for that role. This bypasses filtering and capability checks, not actual API requirements.

Use **Test model capabilities** to verify output structure, image input, tools, and search. Tests use your current prompts and token limits. Match **Generation token limits** to your server’s output and context budgets.

**Local image generation is not supported.**`;
