# Source-code protective orders

Source code produced in litigation (that is, disclosed to the other side) is almost always
produced under a **protective order**: a court order, usually stipulated by the parties, that
says where the code may be inspected, on what machine, with what tools, and what may leave
the room. Since 2025 these orders have also begun to say what may and may not be done with
**AI tools**, and one phrase from that wave, **"fully containerized,"** reaches CodeExam
directly.

This page is in three parts: the basics of source-code protective orders; the 2025–2026 AI
provisions, in detail; and where CodeExam fits, stated in the orders' own terms. It
describes orders and the tool. It is not legal advice, and it does not propose order
language; that is counsel's work.

## 1. What a source-code protective order does

Two model orders set the pattern. The **Northern District of California's model protective
order** for patent, trade-secret and highly sensitive cases, paragraph 9(c), requires that
source code be made available "on a secured computer in a secured room without Internet
access or network access to other computers," and bars copying it onto recordable media.
Zeidman calls it a de facto standard for software IP cases nationally and Fry treats it the
same way; neither cites a survey, but it is the provision every source below argues from.
The **ITC's model order** adds that the
stand-alone computer shall, at the receiving party's request, "include reasonable analysis
tools appropriate for the type of Source Code," supplied by the receiving party and
installed by the producing party.

From those two patterns, a typical order governs the **review computer** (stand-alone, no
network), the **room** (no laptops or phones; sometimes sign-in for breaks), the **hours
and location** (business hours at the producing firm or an escrow facility), **tools** (the
operating system's own, or those the order names), **notes** (handwritten, when nothing
electronic is allowed in), **printing** (capped by pages or lines, with the printouts
reviewed by the producing party first), **copies** (none, on any medium), and increasingly
**AI**. The examiner lives inside those clauses for the life of the case.

## 2. Source-code PO basics, from some useful articles

Each source below is cited, dated, and followed by its key points. The bullets summarize
what the source says (including some negative views of existing protective orders, to which
of course the code examiner must still adhere); CodeExam's own view is in section 4. The
orders exist for a reason the critiques take for granted: a leak of produced source code can
be catastrophic for the producing party, and a court may reasonably require technical
controls that make review slower and costlier. These bullets record the examiner's side of a
two-sided negotiation, and the authors' proposals (video monitoring, observation, antivirus in
place of an air gap) are proposals, not settled substitutes.

<!-- Andrew: one or two additional basics cites go here, same shape. -->

### Schulman, "Source Code Protective Orders, from the perspective of a source-code examiner" (2019, updated 2026)

Andrew Schulman, softwarelitigationconsulting.com, written September 2019, updated through
September 2026.
[Article](https://www.softwarelitigationconsulting.com/source-code-protective-orders-from-the-perspective-of-a-source-code-examiner/).
Read 2026-10-14.

- The typical restrictions, as the examiner meets them: a "standalone" computer with no
  internet, available "M-F 9-6" at the producing firm or an escrow facility; no "laptop,
  mobile devices, etc." in the room, so "only hand-written notes allowed"; no copying of
  "anything (not just source code)" to or from the machine; printing capped by files, pages
  or lines, with printouts reviewed by the producing party before production; and sometimes
  "No analysis of source code" outside the room.
- Tools are the operating system's own (grep, diff, awk, findstr) unless the order names
  more; the article's examples of named tools include Understand, dtSearch, PowerGrep,
  WinMerge, Cygwin, Notepad++ and Visual Studio, and a sample ITC-style addendum under which
  the producing party installs listed tools "at the receiving party's expense" on request.
- The cost: restrictions "dramatically increase source-code examination time and expense"
  and can lower thoroughness. Two code trees on two machines in two cities cannot be compared
  side by side; handwritten-only notes "raise costs and could lower accuracy"; the examiner
  may have to "fly to another city, and stay in a hotel."
- Provisions to push back on: blanket coverage of all code without a particularized showing,
  even code that is open source or already public; bans on quoting code, even in the expert's
  own report, so that the workaround is to "cite proper nouns (function names, variable
  names, etc.)"; patent-case model orders misapplied to copyright and trade-secret cases that
  need source-to-source comparison; the no-laptop rule.
- To attorneys: have a technical expert review a proposed or model order before agreeing,
  and treat source code more like confidential internal email than an automatically secret
  category. To receiving parties: narrow the request and, where possible, name specific files
  and functions in advance, so the other side has less reason to seek restrictive terms.
- If the goal is protecting trade secrets, the producing party's own outside experts perhaps
  should face the same restrictions as the receiving party's examiner.

### Fry, "AI and Source Code Discovery: Protective Orders in a Post-AI World" (2026)

Peter Fry, MooreFry, 2026-07-31, "drafted with AI assistance."
[Article](https://moorefry.com/insights/ai-and-source-code-discovery-protective-orders-in-a-post-ai-world/).
Read 2026-10-14.

- Courts began writing AI provisions into protective orders in 2026, but for produced
  documents; the model orders are "silent on AI for source code review," and the N.D. Cal.
  order does not address what software the reviewing expert may install. The ITC order's
  "reasonable analysis tools" clause, with the producing party installing them, is the one
  model-order hook.
- Cloud AI tools "send the code to someone else's servers," which standard orders already
  forbid during review. Locally-run open-weight models (the article names Qwen3-Coder and
  Devstral) "run entirely on a single machine with no network connection" and would not
  violate an air gap.
- The hardware is the catch: the smallest useful agentic coding model is "a roughly
  14-gigabyte download that wants a high-end GPU or 32 GB of unified memory," and review
  machines are typically workstation-grade laptops without that power.
- The cases: *Morgan v. V2X* (D. Colo. 2026-03-30) ordered disclosure of the AI platforms a
  party had used with confidential information and barred entering it into any AI platform
  whose provider is not contractually barred from training on inputs and bound to delete them
  on request; *Jeffries v. Harcros Chemicals* (D. Kan. 2026-03-25; the article spells it
  *Jefferies*) required advance notice and an opportunity to object before a party uses a
  particular AI tool, and extended the AI restrictions to all discovery documents;
  *Conservation Law Foundation v. Shell Oil* (D. Conn. 2026-05-18) ordered production of the
  prompts an expert had used to cull documents, holding that a stipulation covering "notes,
  drafts, or communications" did not reach them (a magistrate judge's ruling, stayed pending
  district-court review, so not settled); *Matter of Weber*, 2024 NY Slip Op 24258 (N.Y. Sur.
  Ct. 2024-10-10), a state surrogate's-court ruling rather than a general rule, held counsel
  has "an affirmative duty to disclose the use of artificial intelligence" after an expert
  could not recall his Copilot prompts.
- Recommendations for an order: define permitted tools "by mechanism," separating
  cloud-connected AI from models that run on the review machine; require advance notice and
  an opportunity to object to a specific tool; recalibrate the review window to the tooling
  allowed; and "say whether logs of permitted AI use on the review machine are preserved,
  produced, or protected."
- Remote review is the weakest point: "nothing technical prevents a reviewer from
  photographing the screen" and retyping code into an AI tool, so enforcement rests on
  people, through certifications, deposition questions and professional exposure.

### Zeidman, "Outdated Protective Orders are Impeding Software Code Analysis in Copyright and Trade Secret Cases" (2026)

Bob Zeidman, IPWatchdog, 2026-07-29.
[Article](https://ipwatchdog.com/2026/07/29/outdated-protective-orders-are-impeding-software-code-analysis-in-copyright-and-trade-secret-cases).
Read 2026-10-14.

- The N.D. Cal. model order's paragraph 9(c), "without Internet access or network access to
  other computers," has become a de facto standard for software IP cases nationally, and the
  author argues it is outdated.
- Trade secret law asks whether secrecy efforts are "reasonable under the circumstances"
  (the UTSA) or "reasonable measures" (the DTSA), not whether code is totally inaccessible;
  by the no-internet logic, code kept in online repositories such as GitHub would have no
  trade-secret status at all.
- The tools impeded are code-comparison tools that break code into elements and send
  matching fragments, encrypted and out of order, to a search API to check whether the code
  appears in open-source or third-party sources, which the author uses to avoid false
  accusations of copying.
- Parties with weak cases have used the no-network rule to have such tools removed; in one
  matter a judge refused the tool although the opposing side's own permitted tools could also
  reach the Internet; most judges insist on disconnection "in the interest of avoiding the
  appearance of impropriety."
- Proposed instead: malware detection, antivirus and firewalls kept current on the exam
  computer; observation of the expert by the opposing party; video monitoring, including
  machines configured to record the entire exam; and the existing penalties for an expert who
  steals code.
- The author, an engineer rather than a lawyer, closes by asking who can help change the
  thinking on these orders so that code analysis can again be "quantitative and objective."

### Loren & Johnson-Laird, "Computer Software-Related Litigation: Discovery and the Overly-Protective Order" (2012)

Lydia Pallas Loren and Andy Johnson-Laird, *Federal Courts Law Review*, Volume 6, Issue 1
(2012), 63 pages.
[PDF](https://www.fclr.org/fclr/articles/html/2010/Loren_Laird%20-%20Publication.pdf).
Read 2026-10-14.

- Protective orders in software cases are "infected with a kind of paper thinking that does
  not match the technical reality in which the forensic computer expert works": clauses that
  made sense for paper now "serve no purpose except to increase the cost of litigation,"
  which, the authors argue, Rule 26(g)'s certification requirement forbids as a purpose.
- The orders serve two purposes, an agreement on what files are disclosed and how, and
  provisions meant to reduce the risk of leaked code; the second is where over-protection
  lives. The authors see "a clear relationship between the number of restrictions placed on
  forensic software analysts and the cost of the resulting analysis."
- The over-protective clauses they dissect: a stand-alone computer not at the analyst's
  location; the logistics such orders leave out; stand-alone computers at the analyst's
  location; and restrictions on transmitting source code and the expert's own work product.
- Issues "usually omitted" from an order for a remote stand-alone computer, each with a
  proposed clause: the analyst needs a **user account with administrator privileges**, since
  many analysis tools will not run without one; the **operating system** must be fit for the
  load and named in the order; and the **third-party software** the analysis needs must be
  listed in advance, their example list running from revision control and decompression to
  Cygwin and scripting, Understand, Beyond Compare, Office and Acrobat.
- The article's stated goals: help lawyers understand forensic software analysis, give them
  the tools to draft an order of appropriate scope, and help judges evaluate the parties'
  arguments when the scope is fought over.
- Conclusion: "it is possible to provide robust protection for disclosed source code while
  at the same time not unnecessarily increasing the cost of discovery by weaponizing the
  protective order."

### Schulman, *Source Code* book notes, chapter 11, "Source code protective orders"

Andrew Schulman, softwarelitigationconsulting.com, book notes (undated page).
[Chapter](https://www.softwarelitigationconsulting.com/source-code-book/source-code-ch-11-protective-orders/).
Read 2026-10-15. Points not already made above:

- The chapter puts the burden on the party seeking the order to show good cause by a
  particularized need, quoting the case law's "Broad allegations of harm, unsubstantiated by
  specific examples … will not suffice."
- The **Attorneys' Eyes Only** tier bars the opposing *party* itself, especially its in-house
  engineers, from access, which shapes who can sit with the examiner.
- The chapter argues that blanket designation of all source code as highly confidential is no
  substitute for identifying the specific trade secrets, and that where much of the code is
  open source, a vendor's modifications may or may not make its copy a trade secret.
- In the chapter's view comments are "especially likely to be TS," so redacting comments under
  an ordinary NDA is an option short of a full source-code tier.
- A "quick peek"-style selection, in which the requesting side picks the files it wants and
  those are then reviewed and produced, narrows what has to be protected at all.
- Any document that "does quote from source code will thereby come under the PO," expert
  reports and filings included, and the order's effect continues after the case; so "knowing
  the PO restrictions is crucial, before you begin the source-code exam."

## 3. AI provisions in protective orders, 2025–2026

### The four approaches

Joel Bush's survey, "4 Emerging Approaches To AI Protective Order Language" (Law360,
2026-05-12; read 2026-10-14), sorts the 2025 and early-2026 orders into four shapes, each
with its case:

1. **Blanket prohibition.** *Fiorito v. Metropolitan Council*, 2025 WL 1806612 (D. Minn.
   2025-07-01): "No party may upload or otherwise disclose Confidential Data to any
   generative artificial intelligence platform, such as (but not limited to) ChatGPT." Bush
   calls it "virtually impossible to violate unknowingly," though a party can still misjudge
   what counts as an AI platform or as covered material; it forecloses even enterprise tools
   with strong data terms.
2. **Data rights.** *United States v. Jackson*, 2025 WL 1666249 (W.D. Wash. 2025-06-12), and
   *United States v. Navarro Hernandez*, 2025 WL 3290753 (W.D. Wash. 2025-11-26): protected
   material "shall not be loaded into an artificial intelligence (AI) tool or model,
   generative or not, where rights to the data are retained by any party that has not
   explicitly agreed to be covered by the protective order." The test turns on the provider's
   rights in the data, not on the kind of tool; in practice it requires the AI provider
   itself to have agreed to be bound by the court's order, which, Bush notes, most commercial
   providers will not do for a single case.
3. **Contractual safeguards.** *Morgan v. V2X*, 2026 WL 864223 (D. Colo. 2026-03-30), the
   court's own language: no AI use unless the provider is contractually barred from training
   on inputs
   and from third-party disclosure except for essential service delivery, any such third
   party is bound no less protectively, and the party can have all confidential information
   deleted on request, with written documentation retained. The court noted this bars "most,
   if not all, mainstream low-to-no-cost AI," including "standard ChatGPT, Claude, Gemini, or
   similar platforms," and rejected a "secure, closed-circuit environment" formulation as
   aimed at cybersecurity rather than at what AI platforms do with inputs.
4. **Notice and secure environment.** *Jeffries v. Harcros Chemicals Inc.*, 2026 WL 820218
   (D. Kan. 2026-03-25; Nos. 25-2352 and 25-2569; the amended protective order, ECF 153, read
   2026-10-16), paragraph 8: notice and an opportunity to object before a tool is used; use
   of the tool in a secure environment, with discovery materials not used to train or
   improve any AI tool other than one used exclusively in this action and destroyed at its
   end; deletion of all discovery materials from the tool at the conclusion. The notice must
   be served five business days ahead and disclose six things about the tool: its name,
   model and version; its vendor, website and manuals; whether it is self-hosted or
   third-party hosted, who hosts it, where data is processed and stored, and any cross-border
   transfer; its security measures and attestations (SOC 2, ISO 27001, penetration tests);
   whether and how it trains on the materials; and its deletion policies. The order's
   definition of "AI Tool" expressly excludes word processing and spelling checks, citation
   formatting, document comparison, "basic search functions," file conversion and OCR. The
   amended order extends the AI terms to all discovery materials, Bush reports, on the ground
   that clawing back data from an open tool is "impossible as a practical matter."

### "Fully containerized"

A family of stipulated provisions, all from 2026, draws the line with that phrase. Their
status differs and matters: a stipulated order is negotiated language a court entered, not a
judicial finding on each technical assertion in it; a proposed order attached to a status
report is weaker still; and the product lists in both are the parties' examples, not
findings that those products meet the definition. Each is labelled below.

**The two-clause form**, in a **proposed** stipulated order attached to the joint status
report in *In re Zelis Repricing Antitrust Litigation* (D. Mass., No. 1:25-cv-10734, Dkt.
247-1, filed 2026-07-06; the quotation below is taken from the filing's own text, read
2026-10-14; whether the order was later entered as proposed has not been checked), paragraph
18, "Large Language Models / Generative AI Tools":

> "fully containerized," as used in this Order, means an AI tool that does not share the
> substance of a prompt or documents reviewed for training of Large Language Models or use
> the substance of a prompt or documents reviewed in any other matter or inquiry other than
> that or those included in or within this Action.

The same paragraph adds, as a parenthetical, that a containerized tool "does not transmit
any information to any public system or network for the purpose of analysis, use, or the
generation of text outputs," "has the ability to track all information in the system
(including access)," and allows access only to the order's Qualified Persons. It names
OpenAI GPT, ChatGPT, Google Gemini, Meta LLAMA, MidJourney, DALL-E, Claude and Stable
Diffusion as non-containerized, and Harvey, Relativity aiR, DISCO Cecelia, Everlaw AI
Assistant, Legora, Lexis+ AI, Epiq AIDA, Lighthouse AI and Westlaw Co-Counsel as services
"leveraging the technology underlying these generative AI tools in a fully containerized
environment." Other 2026 stipulations repeat the two-clause definition with their own
product lists.

Two features of the *Zelis* paragraph are easy to miss. It opens "Absent notice to and
permission from the Producing Party," so a non-containerized tool is not banned outright but
gated on notice and consent, the *Jeffries* shape. And it binds "any Qualified Person," which
under the order's paragraph 4(viii) includes retained experts and consultants; the Qualified
Persons list mentions AI only for court-reporting and litigation-support services (as carve-ins
for services with AI features, "so long as those systems are 'fully containerized'"), and says
nothing about experts' own use of AI, which therefore falls under paragraph 18's general rule
rather than any expert-specific provision. An expert reading such an order should not take the
silence in the expert clause as either permission or prohibition; the general paragraph is
the one that applies.

**The three-clause form**, in *White v. Chime Financial, Inc.*, 2026 WL 3000904 (W.D. Wash.
2026-10-06), a stipulated order reported as entered, known here only through Michael Berman's
report ("Three More A.I. Protective Orders," E-Discovery LLC, 2026-10-09; read 2026-10-14; the
docket was not located and the order itself was not read): a tool that "does not retain the substance of
a prompt or documents reviewed, share the substance … for training of large language models,
or use the substance … in any other matter or inquiry other than this litigation." *White*'s
permitted list adds Westlaw AI, ChatGPT Enterprise, Microsoft 365 Copilot Enterprise, Claude
Enterprise, NotebookLM Pro and Ultra, and Gemini Pro and Ultra, while "OpenAI, Gemini,
LLAMA" stay on the restricted side.

That last pairing is the key to the phrase as *White* uses it. The same vendor's consumer
product is on the restricted side and its enterprise or paid product on the permitted side,
so **under the *White* definition "containerized" is a statement about what a tool does with
the material (retain, train, reuse) under the terms that govern the account, not about
containers in the software sense**. A Docker image running a cloud model's API client is not
containerized in that sense; a hosted enterprise tenant with no-retention, no-training terms
is. Nor would real containerization settle it: a container isolates a process's filesystem
and namespaces, not its network, and a containerized tool reaches the internet as freely as
any other unless the host forbids it. The term's appeal is intuitive rather than technical.

The word runs three distinct things together, and an order can require any of them: the
provider's **contractual limits** on its use of the material; the **technical isolation** of
the processing environment; and the **path the data actually takes**. A contract establishes
only the first. *White*'s definition asks only for the first; *Zelis*'s parenthetical adds the
third (no transmission to a public system or network) and an access-logging requirement that
is a property of the deployment, not of the terms. So the term is order-specific: what
satisfies *White* does not necessarily satisfy *Zelis*, and contractual safeguards alone do not
satisfy a definition that separately requires isolation, restricted transmission or logging.

Two cautions follow. The product lists in these orders are the parties' stipulated examples
as of the orders' dates (July and October 2026), not findings; every order states its
operative test as the terms, so whether a particular tier of a particular product meets it is
a fact about that tier's agreement at the time, to be checked, not inferred from the name.
And none of the platforms named on the permitted side is a source-code review tool: the lists
come from document-review practice, and a source-code order that wants to permit an AI tool on
the review machine will have to name it.

The *Zelis* parenthetical is where the containerized-AI provisions and the traditional
source-code air gap overlap: a tool that must not transmit anything to a public system or
network, on a review machine that has no network, meets that clause by the machine's
construction; the access-logging clause is a separate requirement that the machine or the
order has to answer.

Three more orders from the same week, also via Berman (all entered orders; the Westlaw
citations are his; the full texts were not read here):

- *Hoffman v. University of Nebraska Medical Center*, 2026 WL 2969621 (D. Neb. 2026-10-02;
  entered on the parties' joint request) bars uploading confidential material to any
  "open-source artificial intelligence platform or service" without written consent, even
  one promising confidentiality, and names closed-source platforms (Harvey, Westlaw,
  LexisNexis, Servient AI Canvas) as permitted.
- *ANR Pipeline Co. v. B&B Metal Processing Co.*, 2026 WL 2970050 (E.D. Wis. 2026-10-02;
  entered as modified by the court) permits AI only in a secure environment under
  enforceable terms barring training and third-party access, with use limited to the
  litigation, and names no products.
- *United States v. Amanuel*, 2026 WL 2964210 (S.D.N.Y. 2026-10-01; entered by consent;
  Berman's post also lists it as 2026 WL 2972618, 2026-10-02, so there may be two orders or
  one misdated) bars publicly accessible tools by example (ChatGPT, Claude, Grok, Gemini,
  Copilot, Perplexity, Midjourney, Canva) and permits a tool only if it keeps materials
  confidential, does not train on them, and removes them when the case ends.

### What the orders now ask of a tool, and of its user

Across the cited orders, several recurring requirements emerge. No single order necessarily
imposes all of them, and the operative language of the applicable order controls. Five recur
in the document-review orders and the source-code orders add a sixth (below, "Fry" refers to
the Peter Fry article cited earlier):

- **No retention, no training, no reuse** across matters (*White*, *Zelis*, *Morgan*,
  *Jeffries*, *Amanuel*). Enterprise agreements for sensitive data commonly add two terms
  that an order of the contractual-safeguards shape may also name: zero data retention of
  prompts and responses by the hosting provider, and inference on US-only servers.
- **Nothing transmitted to a public system or network** for analysis or generation (*Zelis*);
  for source code, nothing off the review machine at all (the model orders, Fry).
- **Disclosure of the tool in advance**, with an opportunity to object (*Jeffries*, Fry), or
  at least on request (*Morgan*; *Weber*'s "affirmative duty to disclose"). *Jeffries* says
  what to disclose: name, model and version; vendor and manuals; self-hosted or third-party
  hosted, and where the data is processed and stored; security measures; training; deletion.
- **Deletion and destruction at the close of the case**, including anything a tool was trained
  or built on (*Jeffries*, *Amanuel*); an embedding index or a fine-tuned model can carry the
  code after the files are gone.
- **Logs**: whether records of permitted AI use are preserved, produced or protected (Fry);
  prompts have been ordered produced (*Conservation Law Foundation v. Shell*); *Zelis* asks the
  tool itself to be able to "track all information in the system (including access)."
- **Installation by the producing party** of tools the receiving party supplies: the ITC model
  order; the *Dow Jones v. Perplexity* Stipulated Source Code Protocol (S.D.N.Y., No.
  1:24-cv-07984, Dkt. 93, 2026-01-20; read 2026-10-14), under which the requesting party
  delivers the software and licenses at least ten days before the first inspection, the
  producing party approves ("which approval may not be unreasonably withheld") and installs
  them, and the software stays on the computers for the litigation. The same protocol defines
  "Source Code Material" to include the files that implement "the development, training,
  evaluation, or deployment of software or machine learning models."

## 4. Where CodeExam fits

CodeExam is a deterministic examination engine with an optional AI layer, and the AI layer
runs in one of two ways. What follows is a requirement-by-requirement account, separating
what CodeExam's code demonstrably does, what its configuration permits, and what has to be
established about the host machine. It is a description of a design and its code, not a test
report; the basis for each claim is stated at the end of this section.

**Local mode** (a GGUF model under node-llama-cpp; see [`LOCAL_LLM.md`](LOCAL_LLM.md)),
against the clauses above:

- **Retention, training, reuse** (*White*; the *Zelis* definition proper). Met by design.
  The model runs in the CodeExam process on the review machine; prompts, code and answers
  go to the model in memory and nowhere else. The model's weights are not modified by use;
  the context (the KV cache) is memory, discarded when the session ends. CodeExam keeps no
  vector database (currently; the possibility of semantic / vector / embeddings search is
  open in issue #322) and does no fine-tuning, so there is no model-side artifact that
  carries the material; the file-side artifacts are inventoried below.
- **No transmission to a public system or network** (the *Zelis* parenthetical). Met by
  CodeExam's own code, not by the environment. `--air-gapped`
  ([`AIR_GAPPED.md`](AIR_GAPPED.md)) is a gate on CodeExam's own cloud-provider calls (every
  outbound AI call site checks it and refuses) plus a connectivity probe at startup that
  refuses to run on a machine with a live network unless told otherwise. It is not a network
  sandbox: it does not stop other software, a dependency's own connections, a later
  reconnection, or a synced save folder. On a review machine with no network, the clause is
  met by the machine; `--air-gapped` adds CodeExam's refusal in code to the machine's
  isolation, and the page linked above says what it cannot guarantee.
- **Access tracking** ("the ability to track all information in the system (including
  access)", *Zelis*). Not met by CodeExam. It currently keeps no access log (it might, and
  arguably should, in future); on a review machine that is the operating system's or the
  VM's job today, and an order that wants it should say so of the machine. Whether the host
  provides it is a fact about the host, to be established separately.
- **Telemetry.** CodeExam has no analytics, telemetry or update checks of its own, and
  sends nothing unless an AI feature is pointed at a cloud provider. (CodeExam's own
  `--breadcrumbs`, run on an index of its source built 2026-10-17, reports 16 trace markers
  and 2 "telemetry events"; all but two of the markers, and both events, are the breadcrumb
  detector's own pattern strings in `src/core/breadcrumbs-commands.js`, its example
  `prefix_event_name` among them, and the other two are progress messages written to the
  terminal. A detector recognizes its own vocabulary, which is the standing hazard of examining
  a code examiner with itself; nothing in the list leaves the machine.)

So local mode meets the data-use clauses by design and the data-path clause by its own code
on an isolated machine, and does not meet the access-logging clause at all. "Satisfies the
order" is a conclusion only the order's full text, the host configuration, and a test of both
can support.

**Cloud engines** (the Claude API, OpenAI, Gemini): the material goes to the provider. Whether
that is permitted depends on the account's terms, which is exactly the line *White* draws
between "Claude Enterprise" (permitted) and "OpenAI, Gemini" (restricted), and *Morgan*'s
four contractual commitments; where an order names zero data retention or US-only inference,
those too are terms of the account. CodeExam cannot see those terms and does not assert them.
On a review machine governed by an order with the model orders' no-network clause the
question is answered before any AI clause applies, because the network path is forbidden;
whether that is so in a given case is a question about that order's operative language, and
`--air-gapped` makes the no-cloud rule CodeExam's own either way.

**What CodeExam writes to disk**, which is what a close-of-case destruction clause must
cover. Deleting the produced source tree does not delete these; each is a derivative that
carries the material in some form:

| Artifact | What it contains | Where | Deleted how |
|---|---|---|---|
| The index directory (`literal_index.json`, `inverted_index.json`, `function_index.json`, `string_table.json`, `func_hashes.json`, `rename_map.json`, `import_map.json`, `vocabulary.json`; [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md)) | The code itself: `literal_index.json` stores every indexed file's lines; the inverted index maps tokens to locations; the string table holds the distinctive strings; the others hold structure, names and vocabulary derived from the code | The directory you named when building | Delete the directory; nothing else references it |
| The zipped-index cache | An unpacked copy of an index that was loaded from a `.zip` | `codeexam-zip-index/<key>` under the system temporary directory (`os.tmpdir()`); CodeExam names the directory on the terminal when it extracts | `ce --clean-zip-cache` removes every cached extraction and says what it removed; or delete the directory by hand. It is not removed automatically |
| Files you asked for: GUI pane saves, chat saves, claim-chart HTML and verdict sidecars (`--chart-html`, `--verdicts-out`), redirected command output | Excerpts, analyses, charts and conversations, which quote the code | Wherever you pointed them; a network drive or a OneDrive / Dropbox-synced folder moves the data off the machine the moment it syncs ([`AIR_GAPPED.md`](AIR_GAPPED.md), "Saving results") | Delete each file; synced copies and backups are the host's to find |
| Chat and overview text not saved | Lives in the GUI page or the terminal until saved; CodeExam keeps no session log of its own. The generated overview, which quotes code, is also kept in the browser tab's session storage for the life of the tab, and the browser writes that to its profile on disk: Chromium-family browsers under the profile's "Session Storage" folder, Firefox inside its session-store files | Memory; the default browser's profile for the overview, until the tab closes | Chat: gone on reload or exit. Overview: the entry goes when the tab closes, but the browser's storage files may hold the bytes until it compacts them, so clear the browser's site data for the GUI's address (127.0.0.1 and its port) as part of the destruction step, or run the GUI in a private window on a review machine so nothing is written to the profile at all |
| The model file (`--model <path>.gguf`) | A stock model you placed; CodeExam never modifies it and does no fine-tuning or merging, so it contains no case material. A model modified by other means would be a different matter | Where you placed it | Delete if the order's definition reaches it |

Not covered by this inventory, because not audited: operating-system backups, VM snapshots and
filesystem journals, which can retain any of the above after deletion and are the host's
concern.

**The six asks, mapped:**

| The order asks | CodeExam today |
|---|---|
| No retention, training or reuse | Local mode: by design. Cloud: the account's terms, not the tool's. |
| Nothing to a public network | Local mode: CodeExam's own code sends nothing; `--air-gapped` gates its cloud calls and refuses to start on a connected machine, but is not a network sandbox and cannot vouch for the machine itself. |
| Disclosure of the tool | An order that asks what tool was used wants the tool, its version, and for AI output the engine, model and settings, so the other side can inspect or re-run it. Against the *Jeffries* list: the version banner names the tool and version, and the provenance header on AI output ([`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)) names the engine, model and run settings for each answer; the vendor is this project and the manuals are these pages; in local mode the tool is self-hosted on the review machine and the data is processed and stored there (the inventory above), while a cloud engine's hosting and location are the provider's to disclose; there are no third-party security attestations; nothing is trained; deletion is the inventory above. A party asked for the hosting, data-location and security items can produce the evidence from the tool itself: see "Examining the examiner" below. `--reproducible` pins the sampling (temperature and seed) so that, within the scope that page states (the same model file and quantization, runtime, settings and machine), a re-run gives the same answer. It improves reproducibility; it does not establish it across machines or versions, and a reproducible answer is not thereby a correct one. |
| Destruction at close | The inventory table above, including the zipped-index cache in the temporary directory; no model-side artifact (vector store, fine-tune) exists to destroy. |
| Logs of AI use | CodeExam appends to every Overview by AI what the answer rested on (the `ⓘ` footer and notes, [`CODEEXAM_NOTATION.md`](CODEEXAM_NOTATION.md)). The Chat pane's save writes the conversation, the examiner's prompts included; `--show-prompt` prints the prompt CodeExam itself sends for an LLM command; and CodeExam's own prompt texts are in its source, listable by indexing CodeExam and running `--prompt-catalog`, though not tied to a particular request. It keeps no prompt log of its own, so an order that wants prompts preserved needs the examiner to save them. |
| Installation by the producing party | [`GETTING_STARTED.md`](GETTING_STARTED.md): a clone or ZIP runs the bare CLI with no install step, because the parser grammars (the tree-sitter `.wasm` files in `grammars/`) and the GUI's vendored libraries (`public/vendor/`) ship in the repository; the GUI and AI features need `npm install` (the MCP and Anthropic SDKs, node-llama-cpp, the tree-sitter engine and two JavaScript tools, plus the 347 packages those resolve to), which fetches packages from the network. **A tested offline install, i.e. CodeExam plus those packages carried to a machine with no network, does not exist yet**; the standalone executable that once filled part of that role was retired (`dc94cdb`). |

**Basis for the claims about CodeExam.** Each was checked by reading the code on
2026-10-14, not by a runtime audit: the air-gap gate and its call sites (`src/core/air-gapped.js`
and every cloud call site), the absence of analytics, telemetry or update checks (a search of
`src/` for those terms and for release lookups), the index directory's file list
(`docs/CODEEXAM_INDEXES.md`), the zipped-index cache (`src/archive.js`), the flags named, the
GUI's in-page caching of chat and overview text, and the install steps in
`docs/GETTING_STARTED.md`. Not audited: the network behaviour of CodeExam's dependencies at
runtime, host backups and snapshots, and a clean offline installation on a review-room
workstation or VM. A party that needs those established should test them on the machine the
order governs, and CodeExam's authors would welcome the results.

**Examining the examiner.** None of this need be taken on trust, because CodeExam can be
run on its own source, and its catalogs answer the questions the *Jeffries* disclosure list
asks about hosting, data location and security measures. Build an index of its `src/` and
`public/` trees, then run the catalogs into one file:

```
ce --build-index @codeexam-files.lst --index-path .CodeExam_src_ndx
ce --index-path .CodeExam_src_ndx --referenced-resources --llm-calls --client-server --models-used --bom --breadcrumbs --prompt-catalog --all-results -v > CE_surfaces.txt
```

Each answers one question. `--referenced-resources` is the external surface: every URL and
host, environment variable, external command and cloud configuration the code names.
`--llm-calls` is every LLM call site, which is the list the air-gap gate has to cover.
`--client-server` is the HTTP surface, the routes the GUI server declares. `--models-used`
is the model ids the code declares. `--bom` is the imports and the external packages, which is
what `npm install` fetches. `--breadcrumbs` is the telemetry markers, and `--prompt-catalog`
is what CodeExam sends to a model. On the 2026-10-17 run (106 files, 80,918 lines): twelve
URLs, of which the only service endpoints are api.anthropic.com, api.openai.com and
generativelanguage.googleapis.com, each the default behind an environment variable, the rest
being the loopback GUI address, the repository URL in file headers, two web links written into
chart footers, and three strings quoted in comments; 26 LLM-call sites, all in the provider
adapters; 96 server routes, all under `/api`; six external packages; no embedded SQL. Read it
as an examiner would: the catalogs are pattern-based, and some hits are CodeExam recognizing
its own detector vocabulary, such as a `Cloud: aws` entry that is the AWS pattern in
`src/core/stack-detectors.js` and two `llama3.x` "local models" that are comments about chat
templates.

A tool's own source is only part of its surface. CodeExam's code imports six packages;
`--bom` lists them, and with `package.json` in the index (add it to the file list and build
with `--add-extensions .json`) corroborates each against the manifest's nineteen declared
dependencies. What the catalogs cannot see is below that: the lockfile resolves those
declarations to 347 packages that `npm install` fetches, none of them indexed, and what any of
them does at runtime, including whether it reaches the network, is the item marked not audited
above. For the full transitive tree, GitHub's dependency graph for the repository (Insights,
Dependency graph, with an SBOM export, and Dependabot alerts built on it) lists every package
including the indirect ones; it is exhaustive where CodeExam's catalog is deliberately scoped
to what the code itself imports or loads (import statements, and the script, stylesheet and
importmap tags of indexed HTML and page templates), with the line that does it. Issue #27 tracks the
bill-of-materials feature. The run also turned up a declared-but-unused pair: `express` and
`zod` were in `package.json` but imported nowhere by CodeExam's code (the GUI server is Node's
own `http`), and both arrive anyway as dependencies of the MCP SDK. The catalog was right and
two of CodeExam's own pages were wrong, which is the point of running it; the two declarations
and the pages were then corrected, and `test/test_declared_dependencies.js` now fails the suite
if a declared dependency goes unimported again.

**Hardware.** Fry's figures (a 14 GB download, a high-end GPU or 32 GB of unified memory)
describe agentic coding models; CodeExam's local path runs smaller models (e.g. Gemma 4 on an
RTX 5080 GPU with 16 GB of VRAM) and has a CPU fallback (`--cpu`), which works but is in
practice too slow to use for real on the model sizes that matter. A GPU-less VM, which is
what review machines often are, is a constraint to plan around rather than a supported
configuration. [`LOCAL_LLM.md`](LOCAL_LLM.md) has the sizing realities.

## 5. Sources

Read 2026-10-14 unless noted.

- Andrew Schulman, "Source Code Protective Orders, from the perspective of a source-code
  examiner" (2019; updated 2026-09-05).
  https://www.softwarelitigationconsulting.com/source-code-protective-orders-from-the-perspective-of-a-source-code-examiner/
- Peter Fry, "AI and Source Code Discovery: Protective Orders in a Post-AI World," MooreFry,
  2026-07-31.
  https://moorefry.com/insights/ai-and-source-code-discovery-protective-orders-in-a-post-ai-world/
- Bob Zeidman, "Outdated Protective Orders are Impeding Software Code Analysis in Copyright
  and Trade Secret Cases," IPWatchdog, 2026-07-29.
  https://ipwatchdog.com/2026/07/29/outdated-protective-orders-are-impeding-software-code-analysis-in-copyright-and-trade-secret-cases
- Lydia Pallas Loren & Andy Johnson-Laird, "Computer Software-Related Litigation: Discovery
  and the Overly-Protective Order," 6 Fed. Cts. L. Rev. 1 (2012).
  https://www.fclr.org/fclr/articles/html/2010/Loren_Laird%20-%20Publication.pdf
- Andrew Schulman, *Source Code* book notes, chapter 11, "Source code protective orders"
  (read 2026-10-15).
  https://www.softwarelitigationconsulting.com/source-code-book/source-code-ch-11-protective-orders/
- Joel Bush, "4 Emerging Approaches To AI Protective Order Language," Law360, 2026-05-12
  (the Westlaw citations for *Fiorito*, *Jackson*, *Navarro Hernandez*, *Morgan* and
  *Jeffries* above are its footnotes).
  https://ktslaw.com/-/media/2026/law360---4-emerging-approaches-to-ai-protective-order-language.pdf
- *Jeffries v. Harcros Chemicals Inc.*, Nos. 25-2352-KHV-ADM and 25-2569-KHV-ADM (D. Kan.),
  Amended Protective Order, ECF 153, filed 2026-03-25 (read 2026-10-16).
  https://storage.courtlistener.com/recap/gov.uscourts.ksd.158740/gov.uscourts.ksd.158740.153.0.pdf
- Michael Berman, "Three More A.I. Protective Orders," E-Discovery LLC, 2026-10-09 (with the
  *White v. Chime Financial* update).
  https://www.ediscoveryllc.com/three-more-a-i-protective-orders/
- *In re Zelis Repricing Antitrust Litigation*, No. 1:25-cv-10734-BEM (D. Mass.), Joint
  Status Report and proposed protective order, Dkt. 247 and 247-1, filed 2026-07-06.
  https://litigationtracker.law.georgetown.edu/wp-content/uploads/2026/07/Pacific-Inpatient-Medical_2026.07.06_JOINT-STATUS-REPORT.pdf
- *Dow Jones & Co. v. Perplexity AI, Inc.*, No. 1:24-cv-07984-KPF (S.D.N.Y.), Stipulated
  Source Code Protocol, Dkt. 93, filed 2026-01-20.
  https://chatgptiseatingtheworld.com/wp-content/uploads/2026/01/Dow-Jones-v-Perplexity-Source-Code-Protocol.pdf
- N.D. Cal. model protective orders: https://cand.uscourts.gov/rules-forms-fees/forms

Related pages: [`AIR_GAPPED.md`](AIR_GAPPED.md), [`LOCAL_LLM.md`](LOCAL_LLM.md),
[`REPRODUCIBILITY.md`](REPRODUCIBILITY.md), [`CODEEXAM_CODECLAIM.md`](CODEEXAM_CODECLAIM.md)
(claim work under a protective order).
