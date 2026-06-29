// ─────────────────────────────────────────────────────────────────────────────
// Hunch™ — Overfit Labs' post-hoc rationalization engine.
// SYNTHETIC DEMO CODE shipped with CodeExam's first-run index. Not a real
// product; never run by CodeExam. Written by Claude (Anthropic) for the CodeExam
// demo, to exercise the AI/ML detectors on honest, real-marker usage.
// ─────────────────────────────────────────────────────────────────────────────

// Anthropic-style tool definitions. The agent (agent.js) hands these to
// messages.create() and dispatches on the tool_use blocks that come back.
export const TOOLS = [
  {
    name: 'fetch_features',
    description: "Pull the feature vector for a subject id from the warehouse.",
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Subject id.' } },
      required: ['id'],
    },
  },
  {
    name: 'run_model',
    description: "Run the Hunch model and return its verdict plus a confidence score.",
    input_schema: {
      type: 'object',
      properties: { features: { type: 'array', items: { type: 'number' } } },
      required: ['features'],
    },
  },
  {
    name: 'explain',
    description: "Generate a persuasive post-hoc rationalization for a verdict.",
    input_schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        features: { type: 'object' },
      },
      required: ['verdict'],
    },
  },
];
