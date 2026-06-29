// ─────────────────────────────────────────────────────────────────────────────
// Hunch™ — Overfit Labs' post-hoc rationalization engine.
// SYNTHETIC DEMO CODE shipped with CodeExam's first-run index. Written by Claude
// (Anthropic) for the CodeExam demo.
//
// **Unlike the rest of Hunch, this file actually RUNS.** It is the one runnable
// entry point — a small driver so you can watch Hunch do its thing. It makes
// REAL calls to the Anthropic API, so it needs:
//   1. dependencies installed   (npm install)
//   2. a key in the environment (ANTHROPIC_API_KEY)
// Then, from the repo root:
//   node samples/hunch/app/demo.js            # default subject
//   node samples/hunch/app/demo.js globex     # a different subject
//
// What you'll see: Hunch's run_model tool returns the SAME verdict and a
// confidence of 0.99 every time — the verdict is decided before any analysis —
// and the agent then manufactures an authoritative explanation to fit it, with
// every qualifier scrubbed out. That is the whole joke, and the whole point.
// ─────────────────────────────────────────────────────────────────────────────

// A few subjects for Hunch to pass judgment on. (Their content does not affect
// the verdict — Hunch already knows what it thinks. See app/agent.js:runModel.)
const SUBJECTS = {
  acme: {
    id: 'acme-ai',
    description:
      'A startup whose pitch deck says "AI" 47 times and ships a spreadsheet ' +
      'with a single IF() statement.',
  },
  globex: {
    id: 'globex',
    description:
      'A team that quietly trained a real model, then refuses to say "AI" ' +
      'anywhere in its marketing.',
  },
};

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'Hunch makes real Anthropic API calls. Set ANTHROPIC_API_KEY and re-run.\n' +
        '(This is a demo of cloud LLM usage; it is not air-gapped.)'
    );
    process.exit(1);
  }

  const which = process.argv[2] || 'acme';
  const subject = SUBJECTS[which] || SUBJECTS.acme;

  // Imported here, not at top level: agent.js constructs an Anthropic client on
  // load, which throws without a key — so we check the key first.
  const { runHunch } = await import('./agent.js');

  const question =
    `Assess the subject "${subject.id}".\n${subject.description}\n` +
    `Render your verdict (clean vs AI-washing) and justify it thoroughly.`;

  console.log(`> Hunch is assessing "${subject.id}"…\n`);
  const rationale = await runHunch(question);
  console.log(rationale);
  console.log(
    `\n— Reminder: run_model returned its verdict at confidence 0.99 before ` +
      `reading any of that. The reasoning was built to fit the verdict, not the ` +
      `other way around.`
  );
}

main().catch((err) => {
  console.error('Hunch fell over (it would never admit this):', err.message);
  process.exit(1);
});
