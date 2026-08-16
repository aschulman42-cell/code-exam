# Claim-chart rules, extracted from Andrew Schulman's published guidance

Two checklists derived from the prose at
[softwarelitigationconsulting.com/claim-charts-book](https://www.softwarelitigationconsulting.com/claim-charts-book/)
and its front-page links:

- **Checklist A — CLAIM PARSING**: how a claim becomes the rows of a chart.
- **Checklist B — OTHER CLAIM-CHART RULES**: everything else about what a chart
  must contain, cite, assert, and avoid.

**Purpose.** A: the specification for CE's `splitClaimElements` and anything
that succeeds it. B: the specification for chart *content* — mostly CodeClaim
territory, some of it already CE's.

## How to read the markers

| marker | meaning |
|---|---|
| **[D]** | **Deterministic** — implementable as a rule, no model needed |
| **[M]** | **Model-assisted** — needs judgement; CE can prompt for it and show its work |
| **[H]** | **Human / legal** — counsel's call; automation should surface, never decide |
| **✓** | already implemented in CE (noted where) |
| **✗** | **measured gap or defect in CE today** |

Markers are this document's editorial judgement, not the author's.

## Sources and their state

| source | state |
|---|---|
| Part I — Introduction: purposes & requirements | OK |
| Part II — Chart types & scenarios | OK |
| Part III — Drafting claim charts | OK |
| Part IV — Specificity: pinpointing, facts, meaning | OK (note: URL is `claim-charts-part-iv`, **not** `claim-charts-book-part-iv` — the pattern breaks here) |
| "Why claim charts?" (LinkedIn) | OK |
| "Claim charts: a brief introduction" (LinkedIn) | OK |
| "Claim charts: preface to forthcoming book" (LinkedIn) | OK |
| 6-part intro to software patent litigation (own site → DisputeSoft) | OK; Parts 2 and 6 mined here, Parts 3–5 not yet |
| **"Common problems in claim charts for patent litigation"** | **BROKEN** — the link points at `linkedin.com/post/edit/…`, an authoring URL that shows a login wall to everyone else. The public slug `linkedin.com/pulse/common-claim-chart-problems-patent-litigation-andrew-schulman` returns **404**. **Not mined.** |
| Parts V–VIII of the book | described in the roadmap, **no links yet** |

---

# CHECKLIST A — CLAIM PARSING

## A1. The core act

- [ ] **[D]** Parse **limitation-by-limitation**, never holistically. *"The most noticeable feature of claim charts is the breaking or splitting or parsing of each claim into smaller components…rather than 'holistically.'"* ✓ CE
- [ ] **[D]** **One limitation per row.** *"Each limitation is placed in a separate row in the chart."* ✓ CE
- [ ] **[D]** A claim is **always a single sentence**; parse within that assumption. ✓ CE
- [ ] **[H]** Granularity is adversarial: *"the patent owner asserting infringement will prefer fewer apparent limitations, and the accused infringer will prefer more; positions are reversed for invalidity."* → argues for a **granularity knob**, not a fixed splitter. ✗ CE has no such control beyond `--elements`.

## A2. Primary dividers

- [ ] **[D]** **Semicolons are the natural seams.** *"tears each claim along its 'seams'… these seams are located along semicolons."* ✓ CE
- [ ] **[D]** **The colon separates the preamble from the body.** ✓ CE detects it, ✗ but see A3.
- [ ] **[D]** The mechanical rule, stated outright: *"Mechanically adding a newline after each semicolon **and after the colon** yields"* the limitations.
      **✗ CE performs only the semicolon half** — see A3.
- [ ] **[D]** **Commas may divide** *"if these clearly delineate limitations"*.
- [ ] **[D]** **But commas are not natural dividers**, *"in part because commas are often used for example in multi-party adjectives describing a single thing."* ✓ CE splits only on `, and`, not bare commas.
- [ ] **[D]** *"the word 'and' is often a good place to divide claims into limitations, sub-limitations, and/or subparts."* ✓ CE

## A3. The preamble — CE's largest measured defect

- [ ] **[D]** **The preamble gets its own row**, always. (Andrew, #310: *"Preamble must always be shown as first row."*)
      **✗ MEASURED: CE discards it on 98.7% of real independent claims** (5,297 of 5,369). The single-line path does `t.slice(ci + 1)`, throwing away everything before the first colon. Both CE test claims are hand-wrapped and take other paths, so this was invisible until a real corpus was used.
      **✗ Worse: the same '101 claim splits into 10 elements multi-line and 2 one-line** — the preamble *and* most limitations are lost. Formatting decides the chart.
- [ ] **[H]** The preamble is **generally not a limitation** — *"unless it 'breathes life and meaning into the claim.'"*
- [ ] **[H]** It **is** limiting when it supplies essential structure, or *"was relied upon at the PTO to distinguish prior art."*
- [ ] **[H]** *"If a claim already recites an entire complete structure, without need of supplementation from the preamble, then the preamble is likely not a limitation."*
- [ ] **[D]** Failure to find code for a preamble is **often not fatal** — so the row must be **marked**, or an ABSENT there reads as a failed limitation. ✗ CE
- [ ] **[D]** Designate it distinctly, e.g. **`[1pre]`**. ✗ CE
- [ ] **[D]** Consequently the **coverage count must separate preamble from limitations**. ✗ CE's `coverageLine()` counts every row identically.

## A4. Method claims and steps

- [ ] **[D]** **Gerunds mark steps**: *"the presence of -ing words (gerunds) that often set forth the beginning of each step."* ✓ CE (`\bfor\s+\w+ing\b`)
- [ ] **[D]** **Built-in designators** `(a)`, `(b)` *"can simply be used as-is."* ✓ CE (2.7% of real claims carry them)
- [ ] **[H]** Step **order matters only** *"if sequence is implied."*
- [ ] **[M]** For a method claim, ask **who carries out the method** — it may not be the defendant.

## A5. Sub-limitations

- [ ] **[D]** Explicit sub-limitations get **their own rows**; implicit ones *"generally will not"* unless the opponent presses them.
- [ ] **[D]** They are *"often set forth with a 'wherein … comprises' clause."* **21.2% of real claims contain one.** ✗ CE does not detect them as sub-limitations.
- [ ] **[D]** Number them **`[1c.1]`, `[1c.2]`** — *"preferable to designating these as [34d] and [34e]"*, because they are **not separate limitations**.
      **Andrew's ruling for CE (#310): flat is generally right.** So this is recorded, not adopted.
- [ ] **[M]** Sub-limitations may carry **embedded preambles** denoting internal structure.
- [ ] **[D]** *"Sutton v. Nokia"* was rejected because its left column held an *"undifferentiated mass of sublimitations"* needing separate rows — under-splitting is a documented failure mode.

## A6. Clauses that DO begin a limitation

- [ ] **[D]** **`wherein`** *"can often be treated as the beginning of a limitation."* ✓ CE. Present in **67.7%** of real claims.
- [ ] **[D]** Andrew's ruling for CE: `wherein` is a **sibling** limitation, not a child.

## A7. Clauses and words that do NOT divide

- [ ] **[D]** **`whereby` is generally non-limiting.** ✗ **CE splits on it** — manufacturing a row that should not exist. Measured at **30 of 5,382 claims (0.56%)**: rare, never zero.
- [ ] **[D]** *"'said', 'the', 'a', and 'an'… almost always will indicate **subparts** rather than entire limitations."* ✓ CE does not split on these.
- [ ] **[D]** Do not split on commas *"when they merely serve grammatical functions within a unitary concept."*

## A8. Choices and alternatives

- [ ] **[D]** **`at least one of …`** — only one alternative need be present. **13.5% of real claims (725).** ✗ CE charts it as an ordinary row and never tells the analysis it is a choice, so an ABSENT may mean *"I did not find both."*
- [ ] **[D]** **`selected from the group consisting of`** — one member suffices. **28 claims.** ⚠ **Trap: this contains the word `consisting` but is a CHOICE, not closed claiming** (A9). A detector must not conflate them.
- [ ] **[D]** **`or a combination thereof`** expands choices to mixtures. 9 claims.
- [ ] **[M]** Distinguish *"descriptive choices where not every member need be present"* from *"cases where device/method itself makes a selection (requiring full group disclosure)."*
- [ ] **[D]** In the chart, **state whether alternatives are ANDed or ORed**. Bare bullets that leave this ambiguous are a named defect.
- [ ] **[D]** Bare `or` appears in **50.8%** of claims — too broad to act on alone. Act on the specific constructions.

## A9. Open vs closed claiming

- [ ] **[D]** **`comprising`** = open: additional elements do not defeat infringement. **94.3%** of real claims.
- [ ] **[D]** **`consisting of`** = closed: *"infringement is found when all the specified elements are found, and _only_ these elements."* **54 claims (1.0%)** excluding the `group consisting of` form. ✗ CE does not distinguish.

## A10. Negative limitations

- [ ] **[D]** Signalled by **`without`, `in the absence of`, `substantially free of`** (also `free from`, `devoid of`, `excluding`). **276 claims (5.1%).** ✗ CE does not detect them.
- [ ] **[M]** **PRESENT/ABSENT semantics invert.** A model shown a negative limitation plus code containing the forbidden feature's vocabulary has every reason to answer PRESENT. **The correct answer is the opposite** — a confident false PRESENT in a legal deliverable.
- [ ] **[H]** Prove a negative *"not by attempting to prove a negative in some global sense"* but by showing absence *"within the confines of the other limitations."*
- [ ] **[H]** Claim construction may permit **de minimis presence** even under a `without` limitation.

## A11. Means-plus-function (35 USC 112(f))

- [ ] **[H]** *"search the **entire claim** (not merely the limitation)"* to decide whether it recites function without sufficient structure. **43 claims (0.8%).**
- [ ] **[H]** `means for…` is a *"sure signal"* but **not the only** indicator.
- [ ] **[H]** The limitation is satisfied only by structure **disclosed in the specification** — *"not to the raw language of claim."*
- [ ] **[D]** In the chart, expand the LHC into bullets naming the **disclosed means**.
- [ ] **[H]** Requires *"clear linking"* of structure to function, or the claim is indefinite.
- [ ] ⚠ **Out of scope for a splitter**: it requires the specification, which CE does not have. Do not smuggle it into parsing.

## A12. Claim construction changes the parse

- [ ] **[H]** *"Claim charts must reflect some claim construction… informed by the patent specification."*
- [ ] **[M]** Where construction expands a term into several attributes, **use those attributes to structure the rows**.
- [ ] **[M]** **Attribute decomposition** — test each component separately: *"notched test specimens"* → *are they specimens? test specimens? notched? used?*; *"outputting latched pixel data"* → *is it data? pixel? latched? output?*
- [ ] **[H]** A chart must employ a ***reasonable*** construction even in the earliest PICs.

## A13. Cross-claim parsing

- [ ] **[D]** **Repeated limitations across claims**: avoid duplication, but **do not** replace with a bare *"see claim 1."*
- [ ] **[D]** Chart **every asserted claim and every limitation within it** — the *"each × 3"* rule.
- [ ] **[H]** Dependent claims may be valid even when the independent claim is not — parse each separately for invalidity.
- [ ] **[M]** **Claim differentiation**: *"Different claims are presumed to have different scope"* — a dependent claim shows the independent must be broader.
- [ ] **[M]** *"Small differences between claims… must mean something."* If the RHC is identical for two limitations, one is probably superfluous — **a self-check CE could run mechanically.**
- [ ] **[M]** **Presumption of consistency**: a term appearing several times *"picks up attributes from each of its occurrences"*, across the claim, the patent, and related patents.

## A14. Granularity — the standing tension

- [ ] **[M]** Do not **over-split**: *"some compound requirements form single capabilities."*
- [ ] **[M]** Do not **under-split**: *"at some point a 'limitation' is so unwieldy that it will look careless and unthoughtful to simply dump it in as a single row."*
- [ ] **[M]** Splitting on raw semicolons alone *"can often result in an unwieldy claim-chart row that ends up glomming together multiple claim attributes that are better handled separately."*
- [ ] **[D]** Alternative to splitting: **RHC subheadings** for the parts (B10).
- [ ] ⚠ **No rule set reaches this.** CE's escape hatch is `--elements @file` (practitioner-supplied rows). Keep it.

## A15. Designation and numbering

- [ ] **[D]** `[1a]`, `[1b]`, … per limitation of claim 1. ✗ CE numbers rows `1..N` with no claim reference.
- [ ] **[D]** `[1pre]` for the preamble. ✗ CE
- [ ] **[D]** `[1c.1]`, `[1c.2]` for sub-limitations. Recorded; **not adopted** per the flat-hierarchy ruling.
- [ ] **[D]** Include the **claim number** in designations when charting dependent claims.
- [ ] **[D]** Reuse the claim's **own** `(a)`/`(b)` designators when present. ✓ CE honours them for splitting.

---

# CHECKLIST B — OTHER CLAIM-CHART RULES

## B1. Structure and format

- [ ] **[D]** Two columns: **LHC** = claim language, **RHC** = accused product / prior-art facts.
- [ ] **[D]** *"No need to fetishize the two-column format"* — table or not, *"even applicable to graphical presentation."*
- [ ] **[D]** One row per limitation; landscape orientation; legal-size paper when the RHC is voluminous.
- [ ] **[D]** LHC column header **repeated on every page** with the patent number.
- [ ] **[D]** Multi-page charts: current claim number and limitation designation **in the header**.
- [ ] **[D]** RHC header: *"a brief name for the accused instrumentality or prior-art reference"*, not a generic phrase.
- [ ] **[D]** Headers/footers must carry **confidentiality designations** (CBI, Attorneys' Eyes Only) per protective order.
- [ ] **[D]** Optional **third column** for claim construction.

## B2. The RHC — three mandatory components

- [ ] **[D]** **(1) An assertion** that the limitation is or is not met.
- [ ] **[D]** **(2) Facts** supporting it, in the **product's own nomenclature**.
- [ ] **[D]** **(3) An explanation** of how or why the facts support the assertion.
- [ ] **[D]** Assertion patterns: *"Defendant's product X embodies this limitation, in the following element and related elements"*; *"Prior-art reference X discloses this limitation, at the following locations…"*
- [ ] **[D]** Non-infringement: *"does not embody, practice, or otherwise include."* Invalidity: *"does not disclose, teach, or suggest."*
- [ ] **[D]** **The "because" formulation**: *Product at [LOCATION] embodies [LIMITATION] **because** [WHY FEATURE = LIMITATION]*.
- [ ] **[D]** **Facts alone are insufficient.** *"It is not helpful to place the information in the chart, without doing something with it."*
- [ ] **[M]** *"Using"* information means *"parsing it to highlight the presence of limitations and subparts."*

## B3. Pinpointing and specificity

- [ ] **[D]** Identify ***specifically where*** each limitation is found — *"the factual equivalent of a legal 'pinpoint' citation."*
- [ ] **[D]** **"Where" ≠ "what"**: *"Identifying a product element is not the same as pinpointing its location."*
- [ ] **[M]** Specificity is **not volume**: *"careful selection of what material 'goes with' each limitation"*, and *"almost the opposite from dumping in… a large amount of material."*
- [ ] **[D]** **Deficient**: *"See defendant's technical manual pages 1-250, herein incorporated by reference."*
- [ ] **[D]** **Compliant**: *"defendant's technical manual [TITLE] at page 123: [SHOW PARAGRAPH]."*
- [ ] **[D]** Even *"15-20 pages of screen shots"*, mostly duplicative, was ruled deficient.
- [ ] **[M]** **Super-pinpointing**: only those lines of source code necessary to meet the limitation.
- [ ] **[M]** *"There is a difference between trying to provide pinpoint factual citations, and not entirely succeeding… and not even trying."*
- [ ] **[M]** *"Less is more. A large claim chart, like a monster truck, suggests a feeling of inadequacy."*
- [ ] **[D]** **No one-to-one mapping requirement**: a limitation may map to 0, 1, or many elements, and vice versa.
- [ ] **[D]** Still, *"material shown in the RHC of a given row should correspond **only** to the limitation in the LHC of that same row."*
- [ ] **[D]** **Do not paste the same large reference into every row.**

## B4. Naming and nomenclature

- [ ] **[D]** Use the **product's** nomenclature in the RHC, *"not mimicking the mere language of the claim."*
- [ ] **[M]** *"The claim limitation and the product/reference need not use the same language, to still refer to the same thing, and for there nonetheless to be literal infringement."*
- [ ] **[M]** **Avoid** *"mindless keyword searching or 'token matching'."* ⚠ Directly relevant: this is the failure mode CE's per-element retrieval and vocabulary-translation prompt exist to avoid.
- [ ] **[M]** Ask: *"If someone were infringing, what terminology would they be using?"* ✓ CE's `buildDiscoverPrompt` asks exactly this.
- [ ] **[D]** For prior art, **explicitly assert** that *"what is called X in the prior-art reference is the same as what is called Y in the newer patent claim."*
- [ ] **[D]** Identify each product *"by name or model number"*, with version, platform and variant.

## B5. Evidence types and hierarchy

- [ ] **[D]** Prefer **primary sources** (product itself, blueprints, source code) over **secondary** (marketing literature, manuals).
- [ ] **[D]** **Marketing materials**: *"typically frowned upon as lacking the detail or reliability necessary"*; *"do not typically identify what a product contains, much less **where** it contains it."*
- [ ] **[D]** **Screenshots**: mixed results; must be *"explained, and tied to a specific limitation"*, never *"in lieu of explanatory text."*
- [ ] **[D]** **Standards documents**: important, but only if the product's adherence can be shown. Do **not** conflate stated adherence with adoption of every element.
- [ ] **[M]** Forward-looking documents (specs, emails) may be **speculative or never implemented**.
- [ ] **[D]** Test/experiment results *"should likely be memorialized in a report that is attached to the claim chart."*
- [ ] **[D]** Prefer *"shorter, rather than longer, quotations."*

## B6. Source code — CE's home ground

- [ ] **[D]** **Cite complete pathnames**: not *"storage.c function foo() at lines 1000-1020"* but *"/product_name/source/2.5/mac_osx/storage.c function foo() at lines 1000-1020."*
- [ ] **[D]** **Use function/structure/method names**, not line numbers alone — line numbers have *"only an indirect relationship to the actual infringing product."* ✓ CE cites `file@Class::method` with absolute line ranges.
- [ ] **[D]** Use **Bates numbers** where available.
- [ ] **[D]** **Protective orders may forbid verbatim quotation** — *"To quote a single entire line… may be viewed as making a copy."* Refer to names and line numbers instead. ⚠ CE currently embeds source in prompts and quotes lines in charts; worth a mode that cites without quoting.
- [ ] **[M]** Not all produced code is in the product — some *"ended up on the cutting-room floor"*; check citations **against the product itself**.
- [ ] **[M]** Not everything in the product **executes**. Irrelevant for apparatus claims, decisive for method claims.
- [ ] **[M]** **Directional errors**: *"Don't use a DoSend() function to meet a limitation which reads a message."* Charts *"often confuse client/send/write with server/receive/read."* ⚠ Mechanically checkable — a real candidate for CE.
- [ ] **[M]** **Same name, different thing**: *"often necessary to 'drill down' below the name."*
- [ ] **[M]** **Comments** are *"extremely useful in short-circuiting"* analysis but may be *"outdated, incorrect, or referring to a somewhat different"* thing.
- [ ] **[H]** Source code is **generally not prior art** — it is *evidence of* what a public product did. Comments especially, since they are compiled away.

## B7. Claim construction in the chart

- [ ] **[D]** **Explicitly incorporate** construction: the court's (later), the party's (earlier), or alternatives.
- [ ] **[D]** Present it as **bullets in the LHC**, and make the RHC reference the **construed** language.
- [ ] **[D]** A common failure: charts *"neglect to use the claim construction in the RHC"*, arguing against raw claim language.
- [ ] **[H]** After a Markman ruling the court's construction **must be followed**.
- [ ] **[H]** Amendment post-Markman requires **surprise** — *"If a party could have anticipated the possibility of a given claim construction, it ought to have been built into the chart in the first place."*
- [ ] **[H]** **One construction serves both infringement and invalidity** — *"The claim construction is not a 'nose of wax.'"* *"What's sauce for the goose is sauce for the gander."*
- [ ] **[M]** Small non-technical words matter — *therein, distinct, said, substantially, adapted to, coupled with, at least, each, predetermined, without…* ⚠ Experts *"have a natural tendency to ignore"* them. **A checklist CE could apply mechanically.**
- [ ] **[M]** **Vague connectives** (*in association with, correlated to, based upon*) act as wildcards but still require *some* shown relationship.
- [ ] **[M]** **Word endings are decisive**: *programmable* (capability) < *programmed* (happened once, by anyone) < *programming* (occurs as part of infringement). *"Easier for a plaintiff to show -able than -ed, and easier to show -ed than -ing."* ⚠ Deterministic to detect.
- [ ] **[M]** **Adjectives reveal breadth**: *"steel baffles"* shows baffles need not be steel.
- [ ] **[M]** **Lexicographer test**: put the term in quotes, Google it — *"see if the first or indeed only hit is to the patent itself."*
- [ ] **[H]** Do not import specification examples into the claim: *"You use the spec to **construe** the claim, but you don't bring material from the spec **into** the claim."*

## B8. Structuring the comparison

- [ ] **[M]** **Function / Way / Result** — required for doctrine of equivalents, *"a careful walk-through (not merely a mantra-like recitation)"*; useful even for literal infringement.
- [ ] **[D]** DoE requires *"an explanation of each function, way, and result that is equivalent and why any differences are not substantial."* A **boilerplate DoE reservation is rejected.**
- [ ] **[D]** **All limitations must be present**, together, forming *"a single method or apparatus."*

## B9. Subheadings and organisation

- [ ] **[D]** Use **RHC subheadings** to break down complicated limitations; *"nearly essential"* when charting multiple references or related products.
- [ ] **[D]** **Always include an overall assertion** tying subheadings together — otherwise *"a disparate bag of nicely-labelled parts."*
- [ ] **[D]** **Incorporation by reference** is allowed: *"See limitation [1d] above."* ✗ CE has no cross-row referencing.

## B10. Multiple patents, products, references

- [ ] **[D]** **Separate chart per patent.**
- [ ] **[D]** **Separate chart per accused product**, unless a **representative instrumentality** is justified.
- [ ] **[D]** Otherwise you get a ***"Frankenchart"*** — limitations drawn from different products.
- [ ] **[D]** **Separate chart per prior-art reference**, unless combining for obviousness.
- [ ] **[D]** **Anticipation requires all limitations in a *single* reference.**
- [ ] **[D]** Obviousness must **identify the combinations** and explain motivation — *"A mere list of prior-art references, without identifying any combinations among them, can't disclose an obviousness theory."*
- [ ] **[D]** For prior-art patents, compare against *"the **entire disclosure**… including the specification and drawings"*, not its claims.

## B11. What to avoid — named defects

- [ ] **[D]** **Boilerplate**: charts *"must be meaningful—as opposed to boilerplate—and non-evasive."*
- [ ] **[D]** **`See, e.g.`** and *"including but not limited to"* — *"suggest incomplete theories rather than cementing case position."*
- [ ] **[D]** **`On information and belief`** — use *"sparingly"*; replace post-discovery *"with better information, or the assertion should be removed."*
- [ ] **[D]** **Reservation-of-rights caveats** *"have little positive effect, and can make a negative impression."* Courts *"do not accept placeholders, boilerplate, or a 'reservation of right to amend'."*
- [ ] **[D]** **Mimicking claim language** in the RHC.
- [ ] **[D]** **Data dumps** without pincites.
- [ ] **[D]** **Undifferentiated masses of sub-limitations** in one row (*Sutton v. Nokia*).
- [ ] **[M]** **Whack-A-Mole**: postponing concrete positions with *"see for example"*.
- [ ] **[H]** Do not treat claims as *"templates for hindsight rooting through prior art."*

## B12. Chart types

- [ ] **[H]** PICs; initial invalidity contentions; post-discovery ICs; anticipation; obviousness; enablement; statutory bar; method claims; DoE; means-plus-function; indirect infringement; "Alice & Bob" (§101); non-infringement contentions; validity contentions; design patents; expert charts; domestic-industry (ITC); importation/exportation; representative instrumentality.
- [ ] **[H]** Design patents use an **"every angle"** approach, not limitation-by-limitation.
- [ ] **[H]** Indirect-infringement knowledge/intent *"may not require limitation-by-limitation treatment, and therefore can be handled outside the claim chart."*

## B13. Purpose and standard

- [ ] **[H]** Charts sit **between notice and proof** — *"a reasonable chance of being able to make its case"*, analogous to *Twombly/Iqbal* plausibility.
- [ ] **[H]** *"The purpose of the Contentions is to outline the theories… and streamline discovery, not to provide proof."*
- [ ] **[H]** They **lock in theories early** — against *"shifting sands"* and *"musical chairs"*.
- [ ] **[H]** *"A claim chart can be incorrect, without thereby offending the claim-chart rules."* The patent owner *"has 'a right to be wrong,' but it does not have a right to be implausible."*
- [ ] **[H]** *"Not a straitjacket into which litigants are locked from the moment their contentions are served."*
- [ ] **[H]** Charts reveal *"gaps, inconsistencies, and weaknesses in one's own case"* — the self-audit use.
- [ ] **[H]** **Adequacy is stage-dependent.** Less is expected of PICs than of post-discovery contentions.

## B14. Procedure, timing, amendment

- [ ] **[H]** PICs due ~14 days after the Initial Case Management Conference; invalidity ~45 days after service.
- [ ] **[H]** Amendment requires **good cause** — *"decidedly conservative"*, unlike pleading amendment.
- [ ] **[H]** Good cause: adverse claim construction; newly-found material prior art despite diligent search; non-public information not discoverable earlier.
- [ ] **[H]** **The burden of proving diligence is on the party seeking to amend.**
- [ ] **[H]** *"Early amendment is much more likely to be granted than later amendment."*
- [ ] **[H]** Adding **accused products** is disfavoured even more than adding theories.
- [ ] **[H]** Amending in **new prior art** is harder still — *"prior art by definition should have been publicly accessible."*
- [ ] **[H]** Omission can **preclude the theory** and the expert testimony that depends on it.
- [ ] **[H]** Charts must be **dated and signed by counsel**, subject to Rule 11 and Rule 26(g).

## B15. Pre-filing investigation

- [ ] **[H]** **Reverse engineering "or its equivalent"** is the expected level of detail.
- [ ] **[H]** Rule 11 inquiry must happen **before** filing, *"not after."*
- [ ] **[H]** **Exhaust public sources** — including *"older versions of the web site at the 'Wayback Machine'."*
- [ ] **[H]** Expense is **not** an excuse; *"plaintiff is master of the expense of proving its case."*
- [ ] **[D]** **Static RE**: strings, metadata, dependencies, disassembly, decompilation. ✓ CE's territory.
- [ ] **[D]** **Dynamic RE**: debuggers, packet sniffers, logs — *"especially"* for method claims.
- [ ] **[M]** Dynamic RE risks *"over-generalizing from behavior seen in some number of tests."*

## B16. Dates

- [ ] **[H]** Infringement → **patent grant date**; invalidity → **priority date** (per-claim for CIPs).
- [ ] **[H]** ***"That which infringes if after, anticipates if before."*** A plaintiff's own infringement chart can be turned into an invalidity chart — *"patent jujitsu."*
- [ ] **[H]** Working/practicing charts sit *"very close"* to a statutory-bar chart; *"pick an example that stays furthest away from the one-year grace period."*
- [ ] **[H]** Damages limited to **six years** before suit (35 USC 286).

## B17. Confidentiality

- [ ] **[D]** AEO material must be *"produced and/or maintained at a designated secure location."*
- [ ] **[D]** Charts quoting proprietary code may need AEO designation or a **redacted version**.

## B18. Tone

- [ ] **[M]** Methodical, not conclusory. Use *"because"*, *"therefore"*.
- [ ] **[M]** Well-organised analysis conveys command of the case; carelessness with complex limitations conveys the opposite.

---

# Where this lands for CE / CodeClaim

**Already CE's, and confirmed by the source:** limitation-by-limitation parsing;
one row per limitation; semicolon seams; gerunds; `(a)`/`(b)` designators;
`wherein` as a boundary; `file@Class::method` citations with absolute line
numbers; the vocabulary-translation instruction that answers *"if someone were
infringing, what terminology would they be using?"*; and the `--elements` escape
hatch for practitioner granularity.

**Measured defects, on the worklist:**

| defect | item |
|---|---|
| preamble discarded (98.7%); rewrap changes the chart | `claim-splitter-preamble-restore` |
| `whereby` treated as a boundary (0.56%) | same item, Part D |
| coverage line mixes preamble with limitations | same item, Part C |
| CHOICE and NEGATIVE constructions unmarked (13.5%, 5.1%) | `claim-verdict-semantics` |

**Named but not yet proposed** — candidates in rough order of how mechanical
they are:

1. **Limitation designations** `[1a]`, `[1pre]`, with claim number — cheap, and
   it is the vocabulary the whole book uses.
2. **Word-ending detection** (`-able` / `-ed` / `-ing`) — deterministic, and the
   source calls the distinction *"crucial"*.
3. **Small-word checklist** (*therein, distinct, substantially, each,
   predetermined…*) — flag them, since experts *"have a natural tendency to
   ignore"* them.
4. **Directional-mismatch check** — *"Don't use a DoSend() function to meet a
   limitation which reads a message"*; charts *"often confuse client/send/write
   with server/receive/read."* CE has call graphs and could test this.
5. **Identical-RHC self-check** — if two limitations get the same cited code,
   *"one of the two claims is superfluous"*, or the chart is wrong.
6. **Cross-row incorporation by reference** — *"See limitation [1d] above."*
7. **Cite-without-quoting mode** — for protective orders that forbid verbatim
   source.
8. **Granularity knob** — the adversarial preference for fewer vs. more
   limitations is a *setting*, not a default.
9. **Sub-limitation numbering** `[1c.1]` — recorded, **not** adopted under the
   flat-hierarchy ruling; revisit only if that changes.

**Explicitly out of scope for automation:** means-plus-function (needs the
specification), all of B12–B16 (legal, procedural, strategic), and every
judgement marked **[H]**. Surface them; never decide them.
