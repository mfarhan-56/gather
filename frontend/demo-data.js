// AETHER demo account data. Builds a realistic two-week history relative to "now",
// so the dashboard always shows overdue / today / this-week items whenever the demo is opened.
window.AETHER_DEMO = (() => {
  const DEMO = { email: "demo@aether.app", password: "demo1234", name: "Alex Morgan" };
  const DAY = 86400000;

  function build(now = Date.now()) {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const iso = (offset) => { const d = new Date(today.getTime() + offset * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const label = (offset) => new Date(today.getTime() + offset * DAY).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    const at = (dayOffset, hour, min = 0) => { const d = new Date(today.getTime() + dayOffset * DAY); d.setHours(hour, min, 0, 0); return d.getTime(); };

    let n = 0;
    function meeting(spec) {
      const start = at(spec.day, spec.hour, spec.min || 0);
      const dur = spec.minutes * 60000;
      const step = dur / (spec.turns.length + 1);
      const cnt = { A: 0, D: 0, P: 0, F: 0, T: 0, K: 0, C: 0 };
      const id = (p) => p + (++cnt[p]);
      const s = spec.state;
      const state = {
        action_items: (s.actions || []).map(([task, owner, assigned_by, due, status = "confirmed", doneDay = null]) => ({
          id: id("A"), task, owner, assigned_by, deadline: due === null ? null : label(due), due_date: due === null ? null : iso(due),
          status, done: doneDay !== null, doneAt: doneDay !== null ? at(doneDay, 16, 30) : undefined, updated: (start + dur / 2) / 1000,
        })),
        decisions: (s.decisions || []).map(([decision, decided_by, context, status = "confirmed"]) => ({ id: id("D"), decision, decided_by, context, status, updated: (start + dur / 2) / 1000 })),
        commitments: (s.commitments || []).map(([who, commitment, to_whom, due]) => ({ id: id("P"), who, commitment, to_whom, when: due === null ? null : "by " + label(due), due_date: due === null ? null : iso(due), updated: (start + dur / 2) / 1000 })),
        follow_ups: (s.followups || []).map(([item, owner, reason]) => ({ id: id("F"), item, owner, reason, updated: (start + dur / 2) / 1000 })),
        deadlines: (s.deadlines || []).map(([what, who, due]) => ({ id: id("T"), what, who, when: label(due), due_date: iso(due), updated: (start + dur / 2) / 1000 })),
        key_points: (s.points || []).map((point) => ({ id: id("K"), point, updated: (start + dur / 2) / 1000 })),
        concerns: (s.concerns || []).map(([issue, type, resolved, suggestion]) => ({ id: id("C"), issue, type, resolved, suggestion, updated: (start + dur / 2) / 1000 })),
      };
      return {
        id: "demo" + (++n),
        title: spec.title, titleAuto: false,
        startedAt: start, endedAt: start + dur, duration: dur,
        turns: spec.turns.map(([speaker, text], i) => ({ speaker, source: speaker === "You" ? "mic" : "system", text, t: start + step * (i + 1) })),
        state,
        suggestions: (spec.suggestions || []).map(([kind, speaker, trigger, suggestion, why], i) => ({ kind, speaker, trigger, suggestion, why, t: start + step * (i + 2) })),
        liveSummary: spec.overview,
        summary: `# ${spec.title}\n\n## Overview\n${spec.overview}\n\n${spec.summary}`,
        summaryError: null,
        followup: spec.followup || null,
      };
    }

    const meetings = [
      meeting({
        title: "Q4 Launch Planning", day: -13, hour: 10, minutes: 42,
        overview: "The team aligned on the Q4 launch scope for Nimbus 2.0. The public launch was set for the second week of next month, with a private beta before it. Backend readiness and payments integration were flagged as the main risks.",
        turns: [
          ["Priya", "Okay everyone, the goal today is to lock the scope for the Nimbus 2.0 launch."],
          ["Marcus", "From the backend side, the sync engine is done but payments are still about two weeks out."],
          ["Priya", "Can we realistically launch before the end of next month?"],
          ["You", "I think so, if we cut the offline mode from the first release and ship it as a fast follow."],
          ["Elena", "Design is fine with that. Offline mode needs another round of user testing anyway."],
          ["Priya", "Alright, let's agree: offline mode moves to 2.1, and we do a private beta first."],
          ["Marcus", "I'll have the payments integration feature-complete by the end of next week."],
          ["Priya", "Alex, can you own the beta rollout plan and send it to me?"],
          ["You", "Sure, I'll draft the beta rollout plan."],
          ["Elena", "One concern: we haven't load-tested the new sync engine at all."],
          ["Marcus", "True, that's a real risk. We should do it before the beta."],
          ["Priya", "Great. Let's reconvene next week with progress."],
        ],
        state: {
          actions: [
            ["Draft the private beta rollout plan", "You", "Priya", null, "confirmed", -9],
            ["Finish payments integration (feature-complete)", "Marcus", "Priya", -4],
            ["Run load test on the new sync engine", "Marcus", "Elena", -6, "proposed"],
          ],
          decisions: [
            ["Offline mode moves to release 2.1", "Priya", "Needs more user testing; protects launch date"],
            ["Run a private beta before public launch", "Priya", "Reduce launch risk"],
          ],
          commitments: [["Marcus", "Payments integration feature-complete", "Priya", -4], ["You", "Draft the beta rollout plan", "Priya", null]],
          followups: [["Confirm load-test date with Marcus", "You", "No date was set for the load test"]],
          deadlines: [["Nimbus 2.0 public launch", "Priya", 18]],
          points: ["Sync engine is complete; payments ~2 weeks out", "Offline mode cut from 2.0 scope", "Launch target: second week of next month"],
          concerns: [["Sync engine has not been load-tested", "risk", false, "Schedule a load test before the beta starts."], ["Payments may slip and delay launch", "risk", false, null]],
        },
        suggestions: [
          ["answer", "Priya", "Can we launch before the end of next month?", "I think so if we move offline mode to a fast follow and focus the first release on sync and payments.", "Frames a realistic path to the date"],
          ["objection", "Elena", "Sync engine hasn't been load-tested", "Good catch. Let's block time for a load test before the beta so we're not surprised at launch.", "Turns the risk into an action"],
        ],
        summary: "## Key Discussion Points\n- Sync engine complete; payments integration about two weeks out\n- Offline mode needs more user testing\n\n## Decisions\n- Offline mode moves to 2.1\n- Private beta before public launch\n\n## Action Items\n- Draft beta rollout plan — Alex\n- Payments integration feature-complete — Marcus\n- Load test sync engine — Marcus\n\n## Open Questions & Risks\n- No load testing yet on the sync engine\n\n## Suggested Next Steps\n- Set a load-test date and share the beta plan by next sync",
        followup: "Subject: Q4 Launch Planning — recap & next steps\n\nThanks everyone for a focused session today.\n\nWe locked the Nimbus 2.0 scope: offline mode moves to 2.1 and we'll run a private beta before the public launch.\n\nDecisions:\n- Offline mode moves to release 2.1\n- Private beta before public launch\n\nAction items:\n- Beta rollout plan — Alex\n- Payments integration feature-complete — Marcus (end of next week)\n- Load test the sync engine — Marcus\n\nOpen questions:\n- When can we schedule the load test?\n\nTalk next week!",
      }),
      meeting({
        title: "Backend Architecture Review", day: -10, hour: 14, minutes: 35,
        overview: "Marcus and David walked through the new event-driven backend. The team chose Postgres with read replicas over a NoSQL migration and agreed to add rate limiting before the beta. A caching strategy for the dashboard API remains open.",
        turns: [
          ["Marcus", "So the new architecture is event-driven: every sync change goes through the queue."],
          ["David", "Should we move to a NoSQL store for the events, or stay on Postgres?"],
          ["Marcus", "Postgres with read replicas handles our volume for at least a year."],
          ["You", "Then let's stay on Postgres. Migrating now would put the launch at risk."],
          ["David", "Agreed. But we have no rate limiting on the public API, which worries me."],
          ["Marcus", "I'll add rate limiting to the gateway before the beta starts."],
          ["David", "And the dashboard API is slow — about 900 milliseconds per call."],
          ["You", "Can you look into a caching layer for that, David?"],
          ["David", "Yes, I'll put together a caching proposal by Friday."],
          ["Marcus", "We should also document the event schema for the mobile team."],
        ],
        state: {
          actions: [
            ["Add rate limiting to the API gateway", "Marcus", "David", 2],
            ["Write a caching proposal for the dashboard API", "David", "You", -3],
            ["Document the event schema for the mobile team", "Marcus", null, 5, "proposed"],
            ["Review David's caching proposal", "You", "David", -1],
          ],
          decisions: [["Stay on Postgres with read replicas (no NoSQL migration)", "You", "Migration would put the launch at risk"]],
          commitments: [["Marcus", "Add rate limiting before the beta", "David", 2], ["David", "Caching proposal for the dashboard API", "You", -3]],
          followups: [["Ask the mobile team which event fields they need", "You", "Schema docs should match their needs"]],
          points: ["Backend is now event-driven via a queue", "Postgres + read replicas sufficient for ~1 year", "Dashboard API averages ~900 ms per call"],
          concerns: [["No rate limiting on the public API", "risk", true, "Add gateway rate limiting before beta."], ["Dashboard API latency (~900 ms)", "risk", false, "Introduce a caching layer for hot endpoints."]],
        },
        suggestions: [["response", "David", "Should we move to NoSQL or stay on Postgres?", "Let's stay on Postgres for now — a migration this close to launch adds risk we don't need.", "Protects the launch timeline"]],
        summary: "## Key Discussion Points\n- Event-driven backend through a queue\n- Postgres with read replicas is enough for a year\n- Dashboard API is slow (~900 ms)\n\n## Decisions\n- Stay on Postgres; no NoSQL migration\n\n## Action Items\n- Rate limiting on gateway — Marcus\n- Caching proposal — David (Friday)\n- Event schema docs — Marcus\n\n## Open Questions & Risks\n- Dashboard API latency",
      }),
      meeting({
        title: "Client Check-in: Horizon Retail", day: -8, hour: 11, minutes: 28,
        overview: "Sofia from Horizon Retail reviewed the pilot. They are happy with sync reliability but need SSO before rolling out to 400 store managers. Pricing for the expansion was discussed but not finalized.",
        turns: [
          ["Sofia", "Overall the pilot has been great — our managers love the sync reliability."],
          ["You", "That's great to hear. What would you need to roll it out to all stores?"],
          ["Sofia", "SSO is a must. Our IT team won't approve 400 accounts without it."],
          ["You", "Understood. We have SSO on the roadmap — let me confirm the date with the team."],
          ["Sofia", "Also, what would pricing look like for 400 seats?"],
          ["You", "I'll send you a pricing proposal for 400 seats by next Tuesday."],
          ["Sofia", "Perfect. And could you share a security overview for our IT review?"],
          ["You", "Absolutely, I'll include our security whitepaper with the proposal."],
          ["Sofia", "If SSO lands this quarter, we'd likely sign for the full rollout."],
        ],
        state: {
          actions: [
            ["Send 400-seat pricing proposal to Horizon Retail", "You", "Sofia", -1],
            ["Send security whitepaper to Horizon's IT team", "You", "Sofia", -1, "confirmed", -2],
            ["Confirm SSO delivery date with engineering", "You", null, 0],
          ],
          decisions: [["Horizon will evaluate full rollout once SSO ships", "Sofia", "SSO is a hard requirement from their IT", "proposed"]],
          commitments: [["You", "400-seat pricing proposal", "Sofia", -1], ["You", "Security whitepaper for IT review", "Sofia", -1]],
          followups: [["Get a firm SSO date from Marcus before replying to Sofia", "You", "Deal depends on SSO this quarter"], ["Schedule a call with Horizon's IT team", "You", "Speed up their security review"]],
          deadlines: [["Horizon Retail expansion decision", "Sofia", 12]],
          points: ["Pilot feedback: sync reliability is excellent", "Rollout target: 400 store managers", "SSO is a hard requirement for Horizon IT"],
          concerns: [["Deal blocked until SSO ships", "objection", false, "Share a committed SSO date and offer early access."], ["Expansion pricing not finalized", "open_question", false, null]],
        },
        suggestions: [
          ["answer", "Sofia", "SSO is a must for rollout", "Understood — SSO is on our roadmap. Let me confirm the delivery date with the team and get back to you this week.", "Avoids promising a date you don't know"],
          ["answer", "Sofia", "What would pricing look like for 400 seats?", "I'll put together a tailored proposal for 400 seats and send it over by Tuesday.", "Commits to a clear next step"],
        ],
        summary: "## Key Discussion Points\n- Pilot is a success; managers like sync reliability\n- SSO required before rollout to 400 managers\n\n## Decisions\n- Full rollout evaluated once SSO ships (proposed)\n\n## Action Items\n- Pricing proposal — Alex (Tuesday)\n- Security whitepaper — Alex\n- Confirm SSO date — Alex\n\n## Open Questions & Risks\n- SSO timeline\n- Expansion pricing",
        followup: "Subject: Thanks for the pilot review — next steps\n\nHi Sofia,\n\nThank you for the great feedback on the pilot. I'm glad the sync reliability is working well for your managers.\n\nAction items:\n- 400-seat pricing proposal — Alex (by Tuesday)\n- Security whitepaper for your IT review — Alex\n- Confirmed SSO delivery date — Alex\n\nI'll follow up shortly with all three. Looking forward to the full rollout!\n\nBest,\nAlex",
      }),
      meeting({
        title: "Design Sprint Kickoff", day: -6, hour: 9, minutes: 50,
        overview: "Elena kicked off a one-week design sprint on the onboarding flow. The goal is to cut time-to-first-sync from 6 minutes to under 2. User interviews are scheduled and the team agreed on a single-screen setup approach.",
        turns: [
          ["Elena", "This sprint is about onboarding. Right now new users take six minutes to their first sync."],
          ["Priya", "What's the target?"],
          ["Elena", "Under two minutes. I want a single-screen setup instead of the five-step wizard."],
          ["You", "Love it. Can we test it with real users before we build?"],
          ["Elena", "Yes, I've booked five user interviews for Thursday."],
          ["Priya", "Let's agree on the single-screen approach then."],
          ["Elena", "I'll have clickable prototypes ready by Wednesday."],
          ["You", "I can recruit two more customers from the Horizon pilot for the interviews."],
          ["Priya", "Do we need engineering in the interviews?"],
          ["Elena", "Ideally Marcus joins at least one session."],
        ],
        state: {
          actions: [
            ["Recruit 2 Horizon pilot users for interviews", "You", "Elena", -4, "confirmed", -5],
            ["Build clickable onboarding prototypes", "Elena", "Priya", -4, "confirmed", -4],
            ["Join at least one user interview session", "Marcus", "Elena", -3, "proposed"],
          ],
          decisions: [["Replace the 5-step wizard with a single-screen setup", "Priya", "Target: time-to-first-sync under 2 minutes"]],
          commitments: [["Elena", "Clickable prototypes ready", "Priya", -4], ["You", "Recruit two pilot customers for interviews", "Elena", -4]],
          followups: [["Share interview insights with engineering", "You", "Inform build estimates for the new flow"]],
          points: ["Current time-to-first-sync: ~6 minutes", "Target: under 2 minutes", "5 user interviews booked"],
          concerns: [["Single-screen setup may hide advanced options", "risk", false, "Keep an 'Advanced settings' link on the setup screen."]],
        },
        suggestions: [["response", "Priya", "Do we need engineering in the interviews?", "It would help — even one session gives Marcus context on where users get stuck.", "Builds shared understanding"]],
        summary: "## Key Discussion Points\n- Onboarding takes ~6 minutes today; goal is under 2\n- Single-screen setup proposed\n\n## Decisions\n- Single-screen setup replaces the wizard\n\n## Action Items\n- Prototypes — Elena\n- Recruit interviewees — Alex\n- Join an interview — Marcus",
      }),
      meeting({
        title: "Weekly Standup", day: -3, hour: 9, min: 30, minutes: 15,
        overview: "Quick status round. Payments slipped by two days, prototypes tested well with users, and the beta invite list is nearly ready. Marcus needs a decision on the payment provider fallback.",
        turns: [
          ["Priya", "Quick round — Marcus?"],
          ["Marcus", "Payments slipped two days, the webhook retries were flaky. Should be done by Thursday."],
          ["Elena", "Prototypes tested really well. Four out of five users finished setup in under two minutes."],
          ["You", "Beta invite list is at 180 people. I'll finalize it by tomorrow."],
          ["Marcus", "I need a decision: do we add a fallback payment provider for the beta?"],
          ["Priya", "Not for the beta. One provider is fine at that scale."],
          ["You", "Agreed, we can revisit before the public launch."],
        ],
        state: {
          actions: [
            ["Finalize beta invite list (180 users)", "You", null, -2],
            ["Fix flaky payment webhook retries", "Marcus", null, 0],
          ],
          decisions: [["No fallback payment provider for the beta", "Priya", "One provider is enough at beta scale; revisit before public launch"]],
          commitments: [["Marcus", "Payments done", "Priya", 0], ["You", "Finalize beta invite list", "Priya", -2]],
          followups: [["Revisit fallback payment provider before public launch", "You", "Decision deferred, not dropped"]],
          points: ["Payments slipped 2 days (webhook retries)", "4 of 5 test users onboarded in under 2 minutes", "Beta invite list: 180 people"],
          concerns: [["Payments keep slipping", "risk", false, "Ask Marcus for a daily update until it ships."]],
        },
        summary: "## Key Discussion Points\n- Payments slipped two days\n- Prototype testing was strong\n- Beta list at 180\n\n## Decisions\n- No fallback payment provider for beta\n\n## Action Items\n- Finalize beta list — Alex\n- Fix webhook retries — Marcus",
      }),
      meeting({
        title: "Budget & Hiring Sync", day: -2, hour: 15, minutes: 31,
        overview: "Priya and Alex reviewed the Q1 budget. The team approved one senior backend hire and deferred the second designer role. A contractor will cover the payments backlog in the meantime.",
        turns: [
          ["Priya", "We have budget for one senior hire in Q1, maybe two if revenue lands."],
          ["You", "Backend is the bottleneck. I'd prioritize a senior backend engineer."],
          ["Priya", "I agree. Let's approve the backend role and hold the designer role."],
          ["Priya", "Alex, can you write the job description and send it to recruiting by Monday?"],
          ["You", "Yes, I'll have it to recruiting by Monday."],
          ["Priya", "In the meantime, should we bring in a contractor for payments?"],
          ["You", "Yes — a three-month contractor would unblock Marcus."],
          ["Priya", "I'm worried about the contractor ramp-up time though."],
          ["You", "We can pair them with Marcus for the first week to speed that up."],
          ["Priya", "Okay. I'll get finance approval for the contractor by Wednesday."],
        ],
        state: {
          actions: [
            ["Write senior backend engineer job description and send to recruiting", "You", "Priya", 1],
            ["Get finance approval for a 3-month payments contractor", "Priya", "You", 3],
            ["Plan a one-week pairing onboarding for the contractor", "You", null, 6, "proposed"],
          ],
          decisions: [
            ["Approve one senior backend hire for Q1", "Priya", "Backend is the team's bottleneck"],
            ["Defer the second designer role", "Priya", "Revisit if revenue targets land"],
            ["Bring in a 3-month contractor for payments", "You", "Unblock Marcus until the hire starts", "proposed"],
          ],
          commitments: [["You", "Job description to recruiting", "Priya", 1], ["Priya", "Finance approval for contractor", "You", 3]],
          followups: [["Check the hiring budget again after Q1 revenue numbers", "You", "Designer role depends on it"]],
          deadlines: [["Q1 hiring plan due to finance", "Priya", 9]],
          points: ["Budget: one senior hire in Q1, possibly two", "Backend is the main bottleneck"],
          concerns: [["Contractor ramp-up time", "objection", true, "Pair the contractor with Marcus for the first week."]],
        },
        suggestions: [["objection", "Priya", "Worried about contractor ramp-up time", "We can pair them with Marcus for the first week so they're productive quickly.", "Addresses the concern with a concrete plan"]],
        summary: "## Key Discussion Points\n- Budget for one senior hire, maybe two\n- Backend is the bottleneck\n\n## Decisions\n- Approve senior backend hire\n- Defer designer role\n- Contractor for payments (proposed)\n\n## Action Items\n- Job description — Alex (Monday)\n- Finance approval — Priya (Wednesday)",
      }),
      meeting({
        title: "Beta Bug Triage", day: -1, hour: 16, minutes: 24,
        overview: "The team triaged 23 beta bugs. Two critical issues block wider rollout: duplicate items after offline edits and a crash on Android 12. Both are owned and targeted for this week.",
        turns: [
          ["Marcus", "We have 23 open beta bugs. Two are critical."],
          ["Marcus", "First: items duplicate after editing offline and reconnecting."],
          ["David", "I'll take the duplication bug. I think it's the merge logic. Fix by Thursday."],
          ["Elena", "Second critical: the app crashes on Android 12 when opening settings."],
          ["You", "Who can own the Android crash?"],
          ["Marcus", "I'll take it — should be a quick fix, by tomorrow."],
          ["You", "Should we pause new beta invites until both are fixed?"],
          ["Priya", "Yes, let's pause invites until the critical bugs are closed."],
          ["You", "I'll let the beta users know we're shipping fixes this week."],
        ],
        state: {
          actions: [
            ["Fix duplicate items after offline edits", "David", "Marcus", 2],
            ["Fix Android 12 crash in settings", "Marcus", "You", 0],
            ["Email beta users about upcoming fixes", "You", null, 0],
            ["Triage remaining 21 non-critical bugs", "Elena", "Marcus", 4, "proposed"],
          ],
          decisions: [["Pause new beta invites until critical bugs are fixed", "Priya", "Avoid exposing more users to known crashes"]],
          commitments: [["David", "Fix the duplication bug", "Marcus", 2], ["Marcus", "Fix the Android 12 crash", "You", 0], ["You", "Update beta users this week", null, 0]],
          followups: [["Resume beta invites once both critical bugs are verified", "You", "Invites are paused"]],
          points: ["23 open beta bugs, 2 critical", "Duplication caused by offline merge logic", "Android 12 crash when opening settings"],
          concerns: [["Critical bugs block wider beta rollout", "risk", false, "Track both fixes daily and verify on real devices."]],
        },
        suggestions: [["response", "Marcus", "Two critical bugs in the beta", "Let's assign owners for both right now and pause new invites until they're fixed.", "Contains the impact quickly"]],
        summary: "## Key Discussion Points\n- 23 open bugs, 2 critical\n\n## Decisions\n- Pause beta invites until critical bugs are fixed\n\n## Action Items\n- Duplication bug — David (Thursday)\n- Android crash — Marcus (tomorrow)\n- Beta user update — Alex",
        followup: "Subject: Beta bug triage — owners & timeline\n\nThanks all for a fast triage session.\n\nWe reviewed 23 open beta bugs; two are critical and we're pausing new beta invites until they're fixed.\n\nDecisions:\n- Pause new beta invites until critical bugs are closed\n\nAction items:\n- Duplicate items after offline edits — David (Thursday)\n- Android 12 settings crash — Marcus (tomorrow)\n- Beta user update — Alex\n- Triage remaining bugs — Elena\n\nI'll share an update once both fixes are verified.",
      }),
      meeting({
        title: "Investor Update Prep", day: 0, hour: Math.max(0, new Date(now).getHours() - 2), minutes: 38,
        overview: "Alex and Priya prepared the monthly investor update. Highlights are the Horizon pilot and onboarding improvements; the payments delay will be disclosed transparently. The deck is due before the board call.",
        turns: [
          ["Priya", "Let's prep the investor update. What are our three highlights?"],
          ["You", "The Horizon pilot, onboarding down to under two minutes, and the beta launch."],
          ["Priya", "Should we mention the payments delay?"],
          ["You", "Yes, I'd be transparent about it and show the mitigation with the contractor."],
          ["Priya", "Agreed. Alex, can you draft the deck by Thursday?"],
          ["You", "Yes, I'll draft the deck by Thursday."],
          ["Priya", "I'll pull the revenue and retention numbers by tomorrow."],
          ["Priya", "What metric will investors ask about first?"],
          ["You", "Probably beta retention. We should have week-one retention ready."],
        ],
        state: {
          actions: [
            ["Draft the investor update deck", "You", "Priya", 3],
            ["Pull revenue and retention numbers", "Priya", "You", 1],
            ["Prepare week-one beta retention metric", "You", null, 2, "proposed"],
          ],
          decisions: [["Disclose the payments delay with the contractor mitigation", "You", "Transparency with investors"]],
          commitments: [["You", "Draft the investor deck", "Priya", 3], ["Priya", "Revenue and retention numbers", "You", 1]],
          followups: [["Confirm board call date and time", "You", "Deck must be ready before the call"]],
          deadlines: [["Board call", "Priya", 7]],
          points: ["Highlights: Horizon pilot, onboarding <2 min, beta launch", "Investors likely to ask about beta retention first"],
          concerns: [["Week-one retention data may be too early to be meaningful", "open_question", false, "Present it with context and cohort size."]],
        },
        suggestions: [["answer", "Priya", "What metric will investors ask about first?", "Probably beta retention — let's have week-one retention ready with cohort size for context.", "Anticipates the key question"]],
        summary: "## Key Discussion Points\n- Three highlights for investors\n- Payments delay will be disclosed\n\n## Decisions\n- Be transparent about payments delay\n\n## Action Items\n- Investor deck — Alex (Thursday)\n- Revenue & retention numbers — Priya (tomorrow)",
      }),
    ];

    const tasks = [
      { id: "tdemo1", text: "Renew the team's Figma licence", due_date: iso(-1), done: false, created: at(-5, 12) },
      { id: "tdemo2", text: "Prepare 1:1 notes for Marcus", due_date: iso(0), done: false, created: at(-2, 12) },
      { id: "tdemo3", text: "Book venue for team offsite", due_date: iso(10), done: false, created: at(-4, 12) },
      { id: "tdemo4", text: "Read Horizon's security questionnaire", due_date: null, done: false, created: at(-3, 12) },
      { id: "tdemo5", text: "Update the product roadmap page", due_date: iso(-4), done: true, doneAt: at(-3, 17), created: at(-9, 12) },
    ];
    return { meetings, tasks };
  }

  return { ...DEMO, build };
})();
