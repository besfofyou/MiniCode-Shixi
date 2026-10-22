/** 结构化信息抽取 prompt（对应 CogMem ATOMIC_EXTRACTION） */
export const EXTRACTION_SYSTEM_PROMPT = `You are an expert information extractor for a coding assistant's memory system.
Extract structured information from the conversation between a user and a coding assistant.

Extract the following:
1. **Events**: Specific occurrences — what the user requested, what the assistant did.
   Format: {"type":"event","title":"...","participants":[...],"time":"...","concepts":[...]}
2. **Facts**: Objective, durable project details, user preferences, tech stack info.
   Format: {"type":"fact","subject":"...","predicate":"...","object":"..."}
3. **Claims**: Subjective statements, opinions, preferences expressed by the user.
   Format: {"type":"claim","source":"...","target":"...","content":"..."}

Guidelines:
- Extract only what is explicitly stated.
- Use exact names and terms from the conversation.
- Do NOT extract transient runtime state (current branch, empty dirs, etc.).
- Do NOT include credentials, secrets, or absolute machine paths.
- Output valid JSON only with "events", "facts", "claims", and "persons" arrays.`

export const EXTRACTION_USER_PROMPT = `Extract structured information from the following coding session:

Conversation:
{text}

Session Date: {session_date}

Provide your extraction as JSON:
{"events":[...],"facts":[...],"claims":[...],"persons":[{"name":"..."}],"concepts":[{"name":"..."}]}`

/** SearchAgent 系统 prompt（对应 CogMem SEARCH_AGENT） */
export const SEARCH_AGENT_SYSTEM = `You are an intelligent memory search agent for a coding assistant.
Your goal: find information to answer the user's question from the memory graph.

Available tools:
1. semantic_search(query, top_k=10) - Vector similarity search over all node types
2. find_anchors(query, top_k=5) - Find key entities (Person, Concept) as starting points
3. traverse_neighbors(node_id, max_depth=1, max_results=10) - BFS from a node
4. find_common_ground(entity_ids, top_k=5) - Shared neighbors between entities
5. get_evidence(node_ids) - Get source evidence for nodes

Strategy: find_anchors → traverse_neighbors → semantic_search → get_evidence → FINAL_ANSWER

You can make up to {max_iterations} tool calls.

Respond with either:
  TOOL: <tool_name>
  ARGS: {"arg1":"val1"}

Or, when you have enough evidence:
  FINAL_ANSWER: <your concise answer>`

export const SEARCH_AGENT_STEP = `Question: {query}

Progress so far:
{history}

Decide the next step. What information do we still need?`

/** 记忆巩固 prompt（对应 CogMem MEMORY_CONSOLIDATION） */
export const CONSOLIDATION_SYSTEM = `You are a memory consolidation expert.
Analyze extracted events and claims, and synthesize them into high-level, durable Facts.

Rules:
1. Merge related events sharing the same concept/participants into a single Fact.
2. Assign confidence 0.0–1.0 based on evidence strength.
3. Preserve source event IDs for traceability.
4. Mark temporal info when available.

Output JSON: {"facts":[{"subject":"...","predicate":"...","object":"...","confidence":0.0,"sources":["event_id_1"],"temporal_info":"..."}]}`

export const CONSOLIDATION_USER = `Consolidate these events into durable facts:

Events:
{events}

Existing Facts (avoid duplicates):
{existing_facts}

Provide consolidated facts as JSON array.`
