#!/usr/bin/env python3
"""Aggregate triage data into final-report.csv + final-report.html."""
import csv, html, json, re, sys
from pathlib import Path

OUT = Path('/home/dan/code/freshell/.worktrees/worktree-triage-20260823/triage-output')

# ---------- load baseline ----------
recs = {}
for line in (OUT / 'baseline-data.jsonl').read_text().splitlines():
    r = json.loads(line)
    recs[r['name']] = r

# ---------- load first-pass summaries ----------
fp_summary, fp_status = {}, {}
for line in (OUT / 'first-pass-table.md').read_text().splitlines():
    if not line.startswith('|') or line.startswith('| worktree') or line.startswith('|---'):
        continue
    cols = [c.strip() for c in line.strip().strip('|').split('|')]
    if len(cols) < 9:
        continue
    fp_summary[cols[0]] = cols[8]
    fp_status[cols[0]] = cols[4]

# ---------- deep-dive verdicts (from the 5 deep-dive reports) ----------
# name: (verdict, confidence, land_effort, analysis, deepdive_file)
DD = {
 'tab-bar-visual-overhaul': ('throw-away-useless','medium','none',
   'Fixed-width tab-bar design never adopted; PR #596 superseded the width approach. No plans/tests/docs worth keeping.',
   '01-tabbar-freshagent-ui.md'),
 'freshagent-undo-redo': ('finish-work','high','medium',
   'Fresh-agent /undo /redo rollback; tasks 1-6 complete with tests; final e2e task (fresh-agent-rollback-rust.spec.ts fork-at-point fixture) never finished. ~19k lines; only 2 conflicting files vs current main (both from PR #677). Worth finishing, not restarting.',
   '01-tabbar-freshagent-ui.md'),
 'resume-button': ('in-main','high','none',
   'Capability shipped via PR #583 (feat/resume-session-button), hardened in #586, Rust-ported in #592, simplified in #593. Branch is a strictly older snapshot; every distinctive file exists on main in evolved form.',
   '01-tabbar-freshagent-ui.md'),
 'attention-bell-wrong-signals': ('in-main','high','none',
   'Squash-landed verbatim as PR #614 same day as last commit. 12/17 footprint files byte-identical to main; the other 5 differ only from post-merge forward evolution. Zero unmerged residue.',
   '01-tabbar-freshagent-ui.md'),
 'restart-resumable-pane': ('finish-work','high','large',
   'Complete Restart-pane transaction design (38 commits, 113 files) predating the reconnect-revive rework; capability concepts still relevant but needs a full re-port onto post-#677 main before any landing.',
   '02-session-restore-reliability.md'),
 'restart-recovery-hardening': ('finish-work','high','medium',
   'Auto-restore crate mid-flight; 18 uncommitted dirty files are real WIP (+3,373 lines: Claude DurableRecoveryProvider adapter, CLI-launch NFC/CLAUDE_CONFIG_DIR canonicalization) - the plan\'s next task. DO NOT DELETE the worktree; commit or extract the WIP first.',
   '02-session-restore-reliability.md'),
 'ws-bootstrap-recovery-flake': ('throw-away-useless','high','none',
   'Branch diff is byte-identical to PR #625 (squash-merged 2026-08-09, reverted same day in #626 "pending further verification"). Branch adds nothing to git history; reviving = revert-of-revert that already failed the trust bar once.',
   '02-session-restore-reliability.md'),
 'df1-session-09-live-watching': ('finish-work','high','small',
   'Committed feature deliberately superseded on main (09495fe07 generation-advance broadcasts, D1-3 comment documents the trade). Only live value: untracked black-box WS-wire acceptance test session09_live_watching.rs. The dirty main.rs is a deliberate TEMPORARY red-proof mutation - never commit it.',
   '02-session-restore-reliability.md'),
 'qa-campaign': ('finish-work','high','small',
   'Closed-loop QA campaign: 7 reviewed Node-oracle file fixes (mkdir ENOTDIR->409, ~\\ tilde, etag, mime, UNC, sanitize, dot-seg) with proof tests never landed - main\'s files.rs is byte-identical to the Aug-6 merge-base. Live gap found: client BrowserPane.tsx converts file:// to /local-file?path= but the Rust server has no /local-file route.',
   '03-campaigns.md'),
 'parity-campaign': ('throw-away-useless','high','none',
   'All 45 commits are ancestors of qa-campaign HEAD - the parity worktree is redundant; everything unlanded lives in qa-campaign.',
   '03-campaigns.md'),
 'deploy-compatibility-rollback': ('finish-work','high','large',
   'Complete, tested (~34k lines) immutable-generation deploy-rollback controller. UNPUSHED - worktree is the only copy. Main chose the simpler setsid+systemd route, so reviving is an architecture/product decision. Push the branch to origin as archive before any deletion.',
   '03-campaigns.md'),
 'df1-control': ('throw-away-useless','high','none',
   'df1 campaign control-plane litter (leases/queue/prompts), not product code; branch already pushed to origin so deletion loses nothing.',
   '03-campaigns.md'),
 'cloud-run-jobs': ('in-main','high','none',
   'Landed as PR #628; main iterated 4+ times beyond (vitest-cloud lane, gcloud-robot identity ladder #678, commit-addressed image tags, per-run job naming). Every diff line vs main is a main-side improvement; zero residue.',
   '04-infra-tooling.md'),
 'playwright-azure-cloud': ('throw-away-useless','high','none',
   'Single-commit Azure Playwright spike; project chose GCP Cloud Run. Script names (test:e2e:cloud) collide with main, so revival would need renaming, not merging.',
   '04-infra-tooling.md'),
 'release-v0.7.6-rc.1': ('throw-away-useless','high','none',
   'Single version-bump commit for 0.7.6-rc.1; release was never tagged and main has moved on (0.7.5 package line still current). Pure string bump, no value.',
   '04-infra-tooling.md'),
 'slash-command-catalogs': ('ready-landing','high','small',
   'Slash-command catalog feature (Claude/Codex/OpenCode) with tests and a converged plan marker - a the-usual run that simply never got its PR. git merge-tree vs current main: ZERO conflicts despite 99 behind; focused suites pass at its HEAD. Needs only broad gate + PR approval.',
   '04-infra-tooling.md'),
 '0gdd-measurement': ('throw-away-useless','high','none',
   'Uncommitted FRESHELL_0GDD_* measurement instrumentation explicitly marked "Do not merge" by the investigation\'s own handoff doc; durable evidence archived outside the repo; main shipped the recommended watcher-driven design since.',
   '05-0gdd-investigation.md'),
 '0gdd-observer': ('throw-away-useless','high','none',
   'Untracked 180KB observer_0gdd.rs from a completed 24h observation campaign; evidence archived at ~/.local/state/freshell/0gdd-observer-20260814-08/; handoff doc says do-not-merge.',
   '05-0gdd-investigation.md'),
 '0gdd-handoff': ('finish-work','high','tiny',
   '1,482-line 0gdd handoff doc (commit 2aec62a10, not ancestor of main) + untracked 2,493-line lab-notes observations file - both docs-only, matching docs/lab-notes/ convention. Land them, then 0gdd-measurement/0gdd-observer deletion is information-loss-free.',
   '05-0gdd-investigation.md'),
}

# first-pass verdicts for non-deep-dived meaningful items handled here too
EXTRA = {
 'reconnect-revive': ('in-main','high','none',
   'Fundamentally landed: squash-merged as PR #677; only residual diff is a test fixture where main generalized model ID strings. Nothing to salvage.'),
 'fix-rust-specs-0q8k': ('in-main','high','none',
   'All 9 rust-only e2e spec registrations already present in main\'s RUST_ONLY_SPECS.'),
 'resilience-sprint': ('in-main','high','none',
   'main inlined detached-session.sh into launch-rust.sh with richer comments; dirty entry is .resilience/ litter.'),
 'rest-codex-terminal-identity': ('skipped-plan','high','none',
   'Handoff + plan docs only; feature landed via PR #584.'),
 'coding-agent-resource-containment': ('skipped-plan','medium','none',
   '3,963-line hardened cgroup-v2 resource-containment plan, zero implementation; feature absent from main - kata candidate before deletion.'),
 'kata-sbnj': ('skipped-plan','medium','none',
   '22.8k-line parallel-safe cloud-runner plan, unexecuted; plan-only.'),
 'session-directory-lazy-page-prep': ('skipped-plan','high','none',
   'Plan + handoff docs only; no code at stake.'),
 'session-directory-page-prep': ('skipped-plan','high','none', '10.4k-line plan only, no code.'),
 'session-directory-page-bound': ('skipped-plan','high','none', '8.3k-line plan only, no code.'),
 'df1-retro': ('skipped-plan','high','none', '103-line df1 campaign retrospective, unlanded; historical interest only.'),
}

VERDICT_TO_CATEGORY = {'ready-landing':'ready-landing','finish-work':'finish-work',
 'throw-away-useless':'throw-away','in-main':'in-main','skipped-plan':'skipped-plan','skipped-trivial':'skipped-trivial'}

rows = []
for name, r in recs.items():
    if name in DD:
        verdict, conf, eff, analysis = DD[name][:4]
        link = 'deep-dive/' + DD[name][4]
    elif name in EXTRA:
        verdict, conf, eff, analysis = EXTRA[name]
        link = ''
    elif r['ancestor'] == 'YES':
        verdict, conf, eff = 'in-main', 'high', 'none'
        analysis = 'Merged (ancestor of origin/main). '
        st = fp_status.get(name, '')
        if 'dirty' in st.lower():
            analysis += 'Dirty files judged non-work: ' + st + '. '
        summ = fp_summary.get(name, '')
        if summ.lower().startswith('merged: '):
            summ = summ[len('merged: '):]
        if summ:
            summ = summ[0].upper() + summ[1:]
        analysis += summ
        link = ''
    else:
        verdict, conf = 'skipped-trivial', 'medium'
        eff = 'none'
        analysis = (fp_summary.get(name, '') + ' [' + fp_status.get(name, '') + ']').strip()
        link = ''
    rows.append({
        'name': name, 'branch': r['branch'], 'date': r['date'],
        'verdict': verdict, 'confidence': conf, 'land_effort': eff,
        'category': VERDICT_TO_CATEGORY[verdict], 'analysis': analysis,
        'deepdive': link, 'ahead': r['ahead'], 'behind': r['behind'], 'dirty': r['dirty'],
    })

rows.sort(key=lambda x: x['date'], reverse=True)
from collections import Counter
c = Counter(r['verdict'] for r in rows)
print('verdict counts:', dict(c))
assert len(rows) == 74, f'expected 74 rows, got {len(rows)}'

# ---------- CSV ----------
with open(OUT / 'final-report.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['num','worktree','branch','date','verdict','confidence','land_effort','category','analysis'])
    for i, r in enumerate(rows, 1):
        w.writerow([i, r['name'], r['branch'], r['date'], r['verdict'], r['confidence'],
                    r['land_effort'], r['category'], r['analysis']])

# ---------- HTML ----------
COLOR = {'ready-landing':'#22c55e','finish-work':'#eab308','in-main':'#64748b',
         'throw-away-useless':'#ef4444','skipped-plan':'#cbd5e1','skipped-trivial':'#e2e8f0'}
LABEL = {'ready-landing':'Ready for landing','finish-work':'Finish work','in-main':'Already in main',
         'throw-away-useless':'Throw away','skipped-plan':'Skipped (plan-only)','skipped-trivial':'Skipped (trivial)'}
counts = {k: sum(1 for r in rows if r['verdict']==k) for k in LABEL}

cards = ''.join(
  f'<div class="card" style="border-top-color:{COLOR[k]}"><div class="n">{v}</div><div class="l">{LABEL[k]}</div></div>'
  for k,v in counts.items())

trs = []
for i, r in enumerate(rows, 1):
    dd = f' · <a href="{html.escape(r["deepdive"])}">deep dive</a>' if r['deepdive'] else ''
    trs.append(
      f'<tr data-verdict="{r["verdict"]}"><td class="num">{i}</td><td class="mono">{html.escape(r["name"])}</td>'
      f'<td class="mono sm">{html.escape(r["branch"])}</td><td>{r["date"]}</td>'
      f'<td><span class="pill" style="background:{COLOR[r["verdict"]]}">{r["verdict"]}</span></td>'
      f'<td>{r["confidence"]}</td><td>{r["land_effort"]}</td>'
      f'<td class="num">{r["ahead"]}</td><td class="num">{r["behind"]}</td><td class="num">{r["dirty"]}</td>'
      f'<td>{html.escape(r["analysis"])}{dd}</td></tr>')

html_doc = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Freshell worktree triage - 2026-08-23</title>
<style>
 body {{ font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; color: #0f172a; background: #f8fafc; }}
 h1 {{ font-size: 1.4rem; }} .meta {{ color: #475569; font-size: .85rem; margin-bottom: 1.25rem; }}
 .cards {{ display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.5rem; }}
 .card {{ background: #fff; border: 1px solid #e2e8f0; border-top: 4px solid #999; border-radius: 8px; padding: .6rem 1rem; min-width: 130px; }}
 .card .n {{ font-size: 1.5rem; font-weight: 700; }} .card .l {{ font-size: .8rem; color: #475569; }}
 .controls {{ display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; margin-bottom: .8rem; }}
 .controls input[type=search] {{ padding: .4rem .6rem; border: 1px solid #cbd5e1; border-radius: 6px; width: 260px; }}
 .controls button {{ border: 1px solid #cbd5e1; background: #fff; border-radius: 6px; padding: .35rem .7rem; cursor: pointer; font-size: .82rem; }}
 .controls button.active {{ background: #0f172a; color: #fff; border-color: #0f172a; }}
 table {{ border-collapse: collapse; width: 100%; background: #fff; font-size: .82rem; }}
 th, td {{ border: 1px solid #e2e8f0; padding: .38rem .5rem; text-align: left; vertical-align: top; }}
 th {{ background: #f1f5f9; cursor: pointer; user-select: none; position: sticky; top: 0; }}
 th .arrow {{ color: #94a3b8; font-size: .7rem; }}
 tr:hover td {{ background: #f8fafc; }}
 .pill {{ color: #fff; border-radius: 999px; padding: .1rem .55rem; font-size: .75rem; white-space: nowrap; }}
 tr[data-verdict="skipped-plan"] .pill, tr[data-verdict="skipped-trivial"] .pill {{ color: #334155; }}
 .mono {{ font-family: ui-monospace, monospace; font-size: .78rem; }} .sm {{ font-size: .72rem; color: #475569; }}
 .num {{ text-align: right; }}
</style>
</head>
<body>
<h1>Freshell worktree triage &mdash; 2026-08-23</h1>
<div class="meta">repo: /home/dan/code/freshell &middot; main: origin/main @ 3d739ca4a (2026-08-23) &middot; {len(rows)} worktrees audited &middot; full narrative in final-report.md</div>
<div class="cards">{cards}</div>
<div class="controls">
 <label for="q">Filter: <input type="search" id="q" placeholder="worktree, branch, analysis&hellip;"></label>
 <span id="vfilters"></span>
</div>
<table id="t">
<thead><tr>
<th data-k="num"># <span class="arrow"></span></th><th data-k="name">worktree <span class="arrow"></span></th>
<th data-k="branch">branch <span class="arrow"></span></th><th data-k="date">date <span class="arrow"></span></th>
<th data-k="verdict">verdict <span class="arrow"></span></th><th data-k="confidence">confidence <span class="arrow"></span></th>
<th data-k="land_effort">land effort <span class="arrow"></span></th><th data-k="ahead">ahead <span class="arrow"></span></th>
<th data-k="behind">behind <span class="arrow"></span></th><th data-k="dirty">dirty <span class="arrow"></span></th>
<th data-k="analysis">analysis <span class="arrow"></span></th>
</tr></thead>
<tbody>{''.join(trs)}</tbody>
</table>
<script>
const data = {json.dumps(rows)};
const tbl = document.getElementById('t');
const tbody = tbl.querySelector('tbody');
const q = document.getElementById('q');
let sortKey = 'date', sortDir = -1, vfilter = null;
const vf = document.getElementById('vfilters');
['all'].concat(Object.keys({json.dumps(LABEL)})).forEach(v => {{
  const b = document.createElement('button');
  b.textContent = v === 'all' ? 'all (' + data.length + ')' : v + ' (' + data.filter(d=>d.verdict===v).length + ')';
  b.dataset.v = v;
  if (v === 'all') b.classList.add('active');
  b.addEventListener('click', () => {{
    vfilter = v === 'all' ? null : v;
    vf.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    render();
  }});
  vf.appendChild(b);
}});
function render() {{
  const needle = q.value.toLowerCase();
  let rows = data.filter(d => (!vfilter || d.verdict === vfilter) &&
    (!needle || (d.name + ' ' + d.branch + ' ' + d.analysis).toLowerCase().includes(needle)));
  const k = sortKey;
  rows.sort((a,b) => (typeof a[k] === 'number' ? a[k]-b[k] : String(a[k]).localeCompare(String(b[k]))) * sortDir);
  tbody.innerHTML = rows.map((d,i) => {{
    const dd = d.deepdive ? ' &middot; <a href="' + d.deepdive + '">deep dive</a>' : '';
    const c = {json.dumps(COLOR)}[d.verdict];
    const dark = d.verdict.startsWith('skipped') ? ' style="background:'+c+';color:#334155"' : ' style="background:'+c+'"';
    return '<tr><td class="num">'+(i+1)+'</td><td class="mono">'+esc(d.name)+'</td><td class="mono sm">'+esc(d.branch)+'</td><td>'+d.date+
      '</td><td><span class="pill"'+dark+'>'+d.verdict+'</span></td><td>'+d.confidence+'</td><td>'+d.land_effort+
      '</td><td class="num">'+d.ahead+'</td><td class="num">'+d.behind+'</td><td class="num">'+d.dirty+'</td><td>'+esc(d.analysis)+dd+'</td></tr>';
  }}).join('');
}}
function esc(s){{ const e = document.createElement('span'); e.textContent = s; return e.innerHTML; }}
q.addEventListener('input', render);
tbl.querySelectorAll('th').forEach(th => th.addEventListener('click', () => {{
  const k = th.dataset.k;
  if (k === sortKey) sortDir *= -1; else {{ sortKey = k; sortDir = 1; }}
  tbl.querySelectorAll('th .arrow').forEach(a => a.textContent = '');
  th.querySelector('.arrow').textContent = sortDir === 1 ? '\\u25b2' : '\\u25bc';
  render();
}}));
render();
</script>
</body>
</html>'''

(OUT / 'final-report.html').write_text(html_doc)
print('wrote final-report.csv and final-report.html')
