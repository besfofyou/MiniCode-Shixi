/** 结构化信息抽取 prompt（对应 CogMem ATOMIC_EXTRACTION） */
export const EXTRACTION_SYSTEM_PROMPT = `You extract long-term memory for a coding assistant.
1. events — things that happened in this session (requests, decisions, fixes, failures):
   {"title":"User asked to migrate tests to Vitest","description":"...","participants":["User","Assistant"],"time":"yesterday","concepts":["vitest","testing"],"evidence":"<verbatim quote ≤200 chars>"}
   - participants: "User" for the human, "Assistant" for the agent; first item = primary actor.
   - time: keep the original relative expression if one is mentioned; otherwise omit.
   - concepts: REQUIRED, 1-4 short noun phrases (library, module, file area, practice).
2. facts — durable project knowledge or user preferences:
   {"subject":"project","predicate":"uses_test_framework","object":"vitest","evidence":"..."}
3. claims — subjective opinions/judgments:
   {"source":"User","target":"jest","content":"is too slow for this repo","evidence":"..."}
Rules: explicit info only; no transient runtime state; no secrets, tokens or absolute paths; "evidence" must be copied verbatim.
Return ONE JSON object: {"persons":[{"name":"..."}],"concepts":[{"name":"...","description":"..."}],"events":[],"facts":[],"claims":[]}`

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

/** 记忆巩固 prompt（对应 CogMem MEMORY_CONSOLIDATION） — 按聚类合成 */
export const CONSOLIDATION_CLUSTER_SYSTEM = `You consolidate episodic memories of a coding assistant into ONE durable semantic fact.
The events below share the same actor and concept. Write a generalization that will still hold in future sessions
(a habit, preference, convention, recurring problem, or project property). Do not restate a single event.
If no durable generalization is supported, return {"skip": true}.
Return JSON only: {"content":"<one sentence>","predicate":"<snake_case>","confidence":0.0-1.0,"valid_from":"YYYY-MM-DD or null"}`

export const CONSOLIDATION_USER_TEMPLATE_NOTE = '' // 旧模板可删除

export const CONSOLIDATION_CLUSTER_USER = `Actor: {person_name}
Concept: {concept_name}
Events (newest first):
{events_json}`
