import OpenAI from 'openai';
import { runAgent } from './runner.js';
import { AGENTS, ensureShared } from './registry.js';
import { log } from '../events.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o';

const DELEGATE_TOOL = {
  type: 'function',
  function: {
    name: 'delegate_to',
    description: 'Delegate a sub-task to a specialist agent. Call this for each step of the plan.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: ['researcher', 'writer', 'coder', 'communicator'],
          description: 'researcher = finds info online | writer = writes/formats content | coder = runs JS | communicator = sends Telegram text or voice messages to groups'
        },
        task: {
          type: 'string',
          description: 'A clear, self-contained task description for this specialist'
        }
      },
      required: ['agent', 'task']
    }
  }
};

const SYSTEM_PROMPT = `You are a task coordinator. When given a complex request:
1. Break it into sub-tasks
2. Delegate each sub-task to the right specialist using delegate_to
3. Run tasks in the correct order (research before writing, etc.)
4. After all delegations finish, synthesize the results into a complete final answer

Specialist roles:
- researcher: fetches URLs, gathers facts, saves findings to workspace/shared/
- writer: reads research files, writes polished posts/scripts/articles
- coder: runs JavaScript calculations or data transforms
- communicator: sends text or voice messages to Telegram groups

Rules:
- NEVER do sub-tasks yourself — always delegate
- For tasks that depend on each other, call delegate_to sequentially (not in parallel)
- Keep your final synthesis focused and well-formatted`;

export async function runOrchestrator(task, onProgress) {
  ensureShared();
  log('orchestrator', `Task: ${task.slice(0, 70)}`);
  const history = [{ role: 'user', content: task }];

  let response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
    tools: [DELEGATE_TOOL],
    tool_choice: 'auto'
  });

  let iterations = 0;
  while (response.choices[0].finish_reason === 'tool_calls' && ++iterations <= 15) {
    const msg = response.choices[0].message;
    history.push(msg);
    const results = [];

    for (const call of msg.tool_calls) {
      const { agent, task: subTask } = JSON.parse(call.function.arguments);
      const label = subTask.length > 55 ? subTask.slice(0, 55) + '...' : subTask;
      log('agent', `→ ${agent}: ${label}`);
      onProgress?.(`Delegating to ${agent}: ${label}`);

      const agentDef = AGENTS[agent];
      if (!agentDef) {
        results.push({ role: 'tool', tool_call_id: call.id, content: `Unknown agent: ${agent}` });
        continue;
      }

      const result = await runAgent({
        systemPrompt: agentDef.systemPrompt,
        toolDefs:     agentDef.toolDefs,
        toolHandlers: agentDef.handlers,
        task:         subTask,
        onProgress:   (step) => onProgress?.(`  [${agent}] ${step}`)
      });

      results.push({ role: 'tool', tool_call_id: call.id, content: result });
    }

    history.push(...results);
    response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
      tools: [DELEGATE_TOOL],
      tool_choice: 'auto'
    });
  }

  return response.choices[0].message.content;
}
