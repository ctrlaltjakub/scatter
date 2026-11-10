# Local providers: connection guide

## API connection

1. Select **Ollama**, **LM Studio**, or **OpenAI-compatible** for other servers and gateways. Enter the API base URL, including `/v1`. Defaults: Ollama `http://localhost:11434/v1`; LM Studio `http://localhost:1234/v1`.
2. The API must expose `GET /v1/models` and streaming `POST /v1/chat/completions`. Enter its **API token**; without authentication, use any nonempty value such as `local`.
3. **Requests go directly from the browser.** Allow the app’s origin in CORS, including `Authorization` and `Content-Type` headers. Browser local-network permissions and HTTPS/mixed-content restrictions also apply.

## Provider settings

- **Ollama:** Add the app’s origin to `OLLAMA_ORIGINS` and restart Ollama. Use the origin you visit, such as `https://www.scatter.study`, `https://beta.scatter.study` or `http://localhost:3000`, without a path. The default local API does not require a token. [Ollama’s origin settings](https://docs.ollama.com/faq#how-can-i-allow-additional-web-origins-to-access-ollama)
- **LM Studio:** Start the local server and turn on **Enable CORS**. If **Require Authentication** is on, use an LM Studio API token. [LM Studio server settings](https://lmstudio.ai/docs/developer/core/server/settings)

The app displays vision and tool support when the provider reports them. Ollama returns capabilities through [model details](https://docs.ollama.com/api-reference/show-model-details); LM Studio includes them in its [model list](https://lmstudio.ai/docs/developer/rest/list).

## Web search

In the provider’s **Search connection** field, choose the interface your server supports:

- **Server-managed · LM Studio MCP:** requires `/api/v1/chat`, authenticated MCP access, and **Allow calling servers from mcp.json**. Enter the configured server name without `mcp/`, plus exact allowed tool names.
- **Server-managed · Responses + remote MCP:** requires `/v1/responses` with server-executed MCP. Enter the search MCP URL reachable by that server and exact allowed tool names. No separate MCP authentication field is provided.
- **Server-managed · LocalAI:** requires Chat Completions with MCP support. Enter the search-server names already configured for the model.
- **Browser-managed · SearXNG:** enter a browser-reachable SearXNG URL with JSON results and CORS enabled. Requires model tool calling. Search requests send no credentials or cookies.

**Allow only read-only search tools.** Keep search-service credentials on the server. **Web search off** disables app-requested search, not independent search enforced by your server.

## Model selection and checks

Assign roles in **Models and generation**. Main and secondary models require vision for image tasks; interactive nodes also require vision for screenshot review, plus reliable coding. Tool calling is recommended.

If capability metadata is incomplete, use **Show all models** for that role. This bypasses filtering and capability checks, not actual API requirements.

Use **Test model capabilities** to verify output structure, image input, tools, and search. Tests use your current prompts and token limits. Match **Generation token limits** to your server’s output and context budgets.

**Local image generation is not supported.**

<details>
<summary>Glossary</summary>

- **Allow calling servers from mcp.json:** “Allow calling servers from mcp.json” is an **LM Studio permission** that lets it invoke **external tools** through servers listed in its mcp.json configuration file.
- **API:** An API, or application programming interface, is a **set of communication rules** that lets software request another program’s services through defined **operations and data formats**.
- **API base URL:** An API base URL is the **shared starting address** for a server’s API endpoints, including **/v1** here, to which paths such as /models are appended.
- **API connection:** An API connection is a **software communication link** through which the app sends prompts to a model server and receives answers using an agreed **request format**.
- **API requirements:** API requirements are the **technical conditions** a server must meet for requests to work, including required endpoints, authentication, and streaming support, regardless of **model-selection overrides**.
- **API token:** An API token is a **credential sent with requests** to gain server access; when this local server requires no authentication, the app still needs a **nonempty placeholder** such as local.
- **app’s origin:** The app’s origin is the combination of its **protocol, hostname, and port**, which the browser uses to identify the requesting website when enforcing **cross-origin access rules**.
- **authenticated MCP access:** Authenticated MCP access is a **credential-verified connection** to tools exposed through Model Context Protocol, the communication standard that lets an AI application invoke **external tools** such as search.
- **authentication:** Authentication is the process of **verifying a requester’s identity** or credentials before granting access, often by checking an **API token** supplied with each request.
- **browser:** A browser is the **web-page software** running the app that, in this setup, sends requests **directly to your model server** rather than through an app-hosted intermediary.
- **Browser local-network permissions:** Browser local-network permissions are **browser access controls** that may require your approval before a website can contact services on **your computer or private network**.
- **Browser-managed · SearXNG:** “Browser-managed · SearXNG” is a search connection mode where the **browser queries SearXNG directly** for JSON results, requiring model tool calling and **cross-origin access permission** without sending credentials or cookies.
- **capability checks:** Capability checks are app-level evaluations of whether a model supports a role’s **required features**, which Show all models can bypass without making an **unsupported feature** work.
- **capability metadata:** Capability metadata is **descriptive information** supplied about a model’s supported features, such as vision or tool calling, which the app uses to determine **role eligibility** but which may be incomplete.
- **Chat Completions:** Chat Completions is an **API interface** that accepts conversation messages and returns a model’s next response, using **/v1/chat/completions** here with streaming output and, for LocalAI search, MCP integration.
- **coding:** Coding is **writing computer instructions** to implement behavior, with interactive nodes requiring models that can produce **reliable code** rather than merely describe what should happen.
- **context budgets:** Context budgets are the **available token capacity** for material a model processes in one request, with input and generated output needing to fit within the server’s **applicable limits**.
- **cookies:** Cookies are **small browser-stored values** that websites use to maintain sessions or preferences; this app **does not send them** with browser-managed SearXNG search requests.
- **CORS:** CORS is a **browser-enforced access mechanism** through which a server declares which website origins may read its responses and which **request headers** they may send.
- **credentials:** Credentials are **authentication details**, such as API tokens or passwords, that prove access rights to a service; browser-managed SearXNG requests **send none** in this app.
- **filtering:** Filtering is the app’s **narrowing of model choices** for a role based on reported capabilities, keeping models without the expected features out of the **displayed selection**.
- **gateways:** Gateways are **intermediary services** that accept the app’s API requests and **forward them** to model servers, potentially translating formats or managing authentication along the way.
- **Generation token limits:** Generation token limits are settings that cap the **amount of model output** per response and must fit the server’s supported output allowance and **available context space**.
- **headers:** Headers are **request or response metadata** sent alongside API content, such as **Authorization and Content-Type**, which carry credentials and identify the format of the transmitted data.
- **HTTPS/mixed-content restrictions:** HTTPS/mixed-content restrictions are **browser security rules** that can block an encrypted HTTPS app from contacting an **unencrypted HTTP server**, potentially preventing local API connections.
- **image input:** Image input is **visual data** sent to a model as part of a request, requiring both the server and model to support **image processing** rather than text alone.
- **image tasks:** Image tasks are requests that require **understanding visual input**, such as describing a photograph or reading a chart, so the assigned model needs **vision support** rather than text-only processing.
- **interactive nodes:** Interactive nodes are **self-contained programs**, such as simulations and calculators, whose generation uses **coding, behavior checks, and screenshot review**.
- **interface:** An interface is an **agreed communication contract** specifying how software exchanges requests and results, such as the **endpoints and message formats** required for a search connection.
- **JSON:** JSON is a **text-based data format** that represents information using named fields, lists, and basic values, letting the app **read search results** as structured data rather than a webpage.
- **LM Studio:** LM Studio is a **desktop application** for downloading and running AI models locally, with a graphical interface and a **built-in API server** that lets other apps use those models.
- **Local image generation:** Local image generation means using a **locally running model** to create new images from instructions, a feature this app **does not support**, distinct from analyzing images supplied as input.
- **Main and secondary models:** Main and secondary models are **AI model assignments** for primary and supporting app roles, and **both require image-understanding capability** when their tasks involve images.
- **MCP authentication:** MCP authentication is the **identity verification** required to access a Model Context Protocol tool service; this app provides **no separate authentication field** for the Responses-based remote MCP connection.
- **MCP support:** MCP support is the ability to use **Model Context Protocol**, a shared format for connecting AI systems to external tools, enabling the server to **invoke search services** through its model interface.
- **model:** A model is a **trained AI system** that processes prompts and produces responses, with capabilities such as **image understanding or tool calling** determining which app tasks it can perform.
- **Model selection and checks:** Model selection and checks is the process of **assigning AI models to tasks** and testing whether they meet requirements such as image input, tool use, and **correct output structure**.
- **model tool calling:** Model tool calling is the ability to generate **structured requests** for external functions, such as search, so the surrounding software can **execute the request** and return results to the model.
- **Models and generation:** “Models and generation” is the **settings area** for assigning models to app roles and configuring **response generation**, including token limits that must fit the server’s capacity.
- **Ollama:** Ollama is a **local AI model runner** that downloads and runs language models on your computer, exposing an **OpenAI-compatible API** so apps can send prompts and receive generated responses.
- **OpenAI-compatible:** OpenAI-compatible describes an API that follows **OpenAI’s request and response formats**, allowing this app to use another provider’s models through **matching endpoints** without connecting to OpenAI itself.
- **output structure:** Output structure is the **organization and formatting** of a model’s response, such as required fields in a machine-readable object, which must match what the **app expects** to process reliably.
- **prompts:** Prompts are the **instructions and information** given to a model to guide its response, with capability tests using your **current prompt settings** so results reflect that configuration.
- **provider:** A provider is a **configured source of AI services** that tells the app which server supplies its models and how to **connect and authenticate**.
- **read-only search tools:** Read-only search tools are functions that **retrieve information** without modifying external data or taking actions such as posting messages, limiting search access to **non-modifying operations**.
- **Search connection:** Search connection is the **provider setting** that selects how search requests reach a search service, using either **server-managed or browser-managed** execution according to the supported interface.
- **search MCP URL:** A search MCP URL is the **network address** of a search service exposing tools through Model Context Protocol, which must be **reachable by the provider server** in the Responses-based connection.
- **search-server names:** Search-server names are the **configured identifiers** of search services already attached to a LocalAI model, which the app supplies to select **which services to use**.
- **search-service credentials:** Search-service credentials are **secrets such as API keys** that authorize access to a search provider and should remain **on the server** rather than being exposed to browser code.
- **SearXNG URL:** A SearXNG URL is the **web address** of a SearXNG search service, which must be browser-reachable and provide **JSON search results** with permission for requests from the app’s origin.
- **server:** A server is a **program that handles requests** from other software, supplying services such as model generation or search through **network-accessible addresses**.
- **server name:** A server name is the **configured identifier** for an MCP tool service, entered in the LM Studio search connection **without the mcp/ prefix** so requests reach the intended service.
- **server-executed MCP:** Server-executed MCP means the **provider server** invokes external tools through Model Context Protocol, handling **tool communication** rather than leaving those requests to the browser.
- **Server-managed · LM Studio MCP:** Server-managed · LM Studio MCP is a **search connection mode** where LM Studio’s /api/v1/chat endpoint runs permitted search tools through **Model Context Protocol** using authenticated access and explicitly enabled configured servers.
- **Server-managed · LocalAI:** “Server-managed · LocalAI” is a search connection mode that uses **LocalAI’s Chat Completions interface** to invoke MCP search services **already configured for the model** on the server.
- **Server-managed · Responses + remote MCP:** “Server-managed · Responses + remote MCP” is a search connection mode where the provider’s **/v1/responses interface** lets its server invoke **remote search tools** through Model Context Protocol rather than through the browser.
- **servers:** Servers are **programs that receive requests** and return results over a network, such as model answers or search results, whether running on **your computer or elsewhere**.
- **Show all models:** Show all models is an option that reveals models normally excluded from a role by **capability filtering**, allowing selection despite incomplete metadata without removing the server’s **actual technical requirements**.
- **streaming:** Streaming is the **incremental delivery** of a model’s answer as it is generated, letting the app display text **before the full response finishes**.
- **Test model capabilities:** Test model capabilities is a **verification feature** that tries output formatting, image input, tool use, and search using your **current prompts and token limits** rather than relying only on model descriptions.
- **token limits:** Token limits are **size caps** measured in chunks of text called tokens, restricting how much a model can receive or generate according to the **specific limit** being configured.
- **Tool calling:** Tool calling is a model’s ability to request **external functions** using structured names and arguments, letting the app or server perform actions such as **web searches** beyond generating text.
- **tool names:** Tool names are the **exact identifiers** of individual operations offered by a connected service, used here to **limit access** to explicitly permitted search functions.
- **tools:** Tools are **callable functions** available through the app or server that perform tasks outside text generation, such as retrieving search results, when a model issues a **structured request**.
- **vision:** Vision is a model’s ability to **interpret images** alongside text, enabling it to answer questions about **visual content** such as objects, diagrams, or screenshots.
- **Web search:** Web search is the **retrieval of online information** through a connected search service, giving models **external results** beyond their training knowledge when the configured interface supports it.
- **Web search off:** “Web search off” is a setting that disables **app-requested searches** but does not prevent **independent server searches** performed under the provider server’s own configuration.

</details>
