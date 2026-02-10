# **Session Organizer Product Specification**

This document specifies a self-hosted, browser-accessible product for managing development workspaces composed of multiple terminal and browser panes, with first-class support for multiple autonomous coding-agent CLIs and a configuration-driven extension mechanism. 

## **1. Scope and supported environments**

The product must run as a locally hosted service on a developer machine and be usable from one or more client devices via a web browser on the same network (including over VPN). [Tests: T-BOOT-001, T-SEC-004]

The product must support the following host operating systems:

* Windows (primary support)
* macOS
* Linux

All functional acceptance tests marked as cross-platform must pass on all supported host operating systems. [Tests: T-OS-001, T-OS-002, T-OS-003, T-QA-001]

The product must support the following client environments:

* Desktop browsers (latest stable versions of at least two major browser engines)
* Mobile browsers (touch input, virtual keyboard behavior)

Core workflows must be usable on mobile without relying on a hardware keyboard. [Tests: T-UI-TOUCH-001, T-UI-TOUCH-002]

## **2. Definitions**

Workspace: A top-level user-managed container represented as a tab in the UI. A workspace contains panes and has a restorable state. [Tests: T-TAB-001]

Tab: The UI representation of a workspace in the tab bar. Closing a tab closes the workspace from the active UI while preserving its restorable record. [Tests: T-TAB-004, T-HIST-WORKSPACE-001]

Pane: A sub-unit within a workspace. Each pane is either a terminal pane or a browser pane. A workspace can contain any number of panes. [Tests: T-PANE-001, T-PANE-002, T-PANE-010]

Terminal pane: A pane that hosts an interactive terminal session connected to a process on the host machine. Terminal panes can run plain shells or agent CLIs. [Tests: T-TERM-001, T-PROV-LAUNCH-001]

Browser pane: A pane that displays a web page (typically a development server, documentation, or a local preview). Browser panes support viewport presets and custom sizes. [Tests: T-BROW-001, T-BROW-002]

Provider: A named integration for an external agent CLI. A provider defines how to launch the CLI and how to discover and describe its past sessions, primarily via configuration. [Tests: T-PROV-CATALOG-001, T-PROV-EXT-001]

Discovered session: A past run recorded by a provider (for example, a conversation/session log). Discovered sessions appear in the product’s session history. [Tests: T-HIST-SESSION-001]

Workspace history record: A persisted record of a closed workspace tab (including panes and layout) that can be reopened later. [Tests: T-HIST-WORKSPACE-001, T-TAB-005]

## **3. User journeys**

### **3.1 First launch and secure access**

A user opens the product in a browser and can authenticate when required, then reaches the main workspace UI. [Tests: T-BOOT-001, T-AUTH-001]

If the product is bound to a non-loopback network interface, the product must require authentication for both HTTP and real-time connections, and must refuse to start (or refuse remote binds) when authentication is not configured. [Tests: T-SEC-001, T-SEC-002]

If a user is unauthenticated, the product must present a clear path to authenticate that does not require placing secrets into persistent browser storage. [Tests: T-AUTH-004, T-SEC-003]

### **3.2 Create a new workspace with the default pane**

A user creates a new workspace. The workspace opens with exactly one pane, and the pane type is determined by user settings (for example: terminal, specific provider terminal, or browser). [Tests: T-TAB-001, T-SET-DEFAULTS-001]

The user can immediately interact with that pane (type in a terminal, or navigate a browser pane). [Tests: T-TERM-001, T-BROW-001]

### **3.3 Add panes to a workspace and run parallel tasks**

Within a workspace, the user adds additional panes to run multiple processes concurrently (for example: multiple agent CLIs, a plain terminal running a server, and a browser pane previewing the app). [Tests: T-PANE-003, T-PANE-010]

The user can change pane layout (split/resize/rearrange) and switch focus between panes using mouse/touch and keyboard. [Tests: T-PANE-004, T-PANE-005, T-UI-KB-002]

### **3.4 Close a workspace and reopen it later**

A user closes a workspace tab. The workspace is removed from the active tab bar, and a restorable record is saved. [Tests: T-TAB-004, T-HIST-WORKSPACE-001]

When the user reopens the workspace from history, the workspace’s panes are restored and, as far as possible, the state of each pane is restored (terminal reattach when still running; browser URL/viewport restored). [Tests: T-TAB-005, T-TERM-REATTACH-001, T-BROW-RESTORE-001]

### **3.5 Recover from connectivity loss or browser refresh**

If the client loses connectivity or refreshes the page, running terminal sessions must continue on the host, and the UI must automatically reconnect and restore the active workspaces and their panes without requiring manual reconfiguration. [Tests: T-REL-RECONNECT-001, T-TERM-REPLAY-001, T-TAB-RESTORE-001]

User input entered during a disconnect must not be silently dropped; it must either be delivered after reconnect or clearly rejected with a visible indicator. [Tests: T-REL-INPUT-001]

### **3.6 Work with discovered session history**

A user views session history and sees sessions discovered from supported providers, grouped and searchable. The user can open a session’s details, apply overrides (rename/describe/color), and soft-delete entries. [Tests: T-HIST-SESSION-001, T-HIST-SEARCH-001, T-HIST-OVERRIDE-001, T-HIST-DELETE-001]

### **3.7 Add a new provider without code changes**

A user (or test harness) adds a new provider definition via configuration. The provider appears in the provider catalog, can be enabled, and can launch into a terminal pane when available. [Tests: T-PROV-EXT-001, T-PROV-EXT-002, T-PROV-LAUNCH-003]

## **4. Product invariants**

Terminal output must never be routed to the wrong terminal pane, including during reconnects and rapid tab switching. [Tests: T-TERM-ROUTING-001, T-REL-RECONNECT-001]

Closing a workspace tab must not terminate its running terminal processes unless the user explicitly requests termination. [Tests: T-TAB-004, T-TERM-KILL-001]

The product must maintain a consistent and restorable mapping between workspace panes and their underlying processes (or resources), even if the client disconnects and reconnects. [Tests: T-TERM-REATTACH-001, T-TAB-RESTORE-001]

Authentication secrets must not be stored in persistent browser storage and must not appear in URLs after initial authentication is processed. [Tests: T-SEC-003, T-AUTH-004]

Provider-specific behavior must be primarily declarative. Adding or modifying a provider must not require rebuilding or changing application code for common cases (launch + basic discovery). [Tests: T-PROV-EXT-001, T-PROV-EXT-004]

The product must fail safely: when a required capability is missing (for example: an agent CLI is not installed), the UI must present the provider as unavailable and prevent launching, while still allowing other functionality. [Tests: T-PROV-AVAIL-001]

## **5. Functional requirements**

### **5.1 Application structure and navigation**

The product must provide the following top-level areas:

* Workspaces (active tabs and panes)
* Session history (provider-discovered sessions)
* Workspace history (closed/restorable workspaces)
* Settings
* Diagnostics (for troubleshooting, suitable for development and QA)

Each area must be accessible on desktop and mobile and must be reachable without relying on hover-only UI. [Tests: T-UI-NAV-001, T-UI-TOUCH-001]

### **5.2 Workspaces and tabs**

A workspace must have:

* A stable identifier
* A human-readable name
* A project root (used for grouping, colors, and defaults)
* A set of panes plus a layout definition
* A persisted history record when closed

[Tests: T-TAB-001, T-TAB-002, T-TAB-003, T-HIST-WORKSPACE-001]

Creating a new workspace must:

* Use the default pane configuration from settings
* Set the workspace project root using deterministic rules (for example: from the first terminal pane’s chosen working directory, or from an explicit user selection)

[Tests: T-TAB-001, T-TAB-PROJECTROOT-001, T-SET-DEFAULTS-001]

Closing a workspace must:

* Remove it from the active tab bar immediately
* Persist a workspace history record
* Detach any running terminal panes in that workspace (keeping them running by default)

[Tests: T-TAB-004, T-HIST-WORKSPACE-001, T-TERM-DETACH-001]

Reopening a closed workspace must:

* Recreate the workspace with its previous name, project root, panes, and layout
* Attempt to restore each pane’s state as defined in the pane requirements

[Tests: T-TAB-005, T-TAB-RESTORE-001, T-PANE-RESTORE-001]

The product must support reopening the most recently closed workspace as a single action. [Tests: T-HIST-WORKSPACE-002, T-UI-KB-006]

### **5.3 Panes and layout**

A workspace must support any number of panes. There must be no hardcoded pane-count limit smaller than the configured maximum, and the default configuration must allow at least 8 panes in a single workspace. [Tests: T-PANE-010, T-SET-LIMITS-001]

The product must support arranging panes in a split layout with user-controlled resizing. [Tests: T-PANE-004, T-PANE-006]

The product must support:

* Adding a new pane (terminal or browser)
* Closing a pane
* Focusing a pane
* Moving a pane within the layout
* Converting a pane’s role within a workspace (for example: replacing a pane’s content while preserving its position in the layout)

[Tests: T-PANE-001, T-PANE-002, T-PANE-007, T-PANE-008]

Each pane must have:

* A stable identifier within the workspace
* A type (terminal or browser)
* A title or label visible to the user
* A persisted state model (type-specific)

[Tests: T-PANE-009, T-PANE-RESTORE-001]

### **5.4 Terminal panes**

#### **5.4.1 Shell and process execution**

A terminal pane must run an interactive process on the host machine and display input/output with correct ordering and no corruption for typical interactive usage. [Tests: T-TERM-001, T-TERM-002]

Supported shells must include:

* Windows: at least one native shell available by default on Windows
* macOS/Linux: the user’s default system shell (or a configured shell path)

[Tests: T-OS-001, T-OS-002, T-OS-003, T-TERM-SHELL-001]

A terminal pane must support:

* Setting initial working directory on creation
* Resizing (rows/cols) based on pane size changes
* Copy/paste behavior appropriate to a web terminal
* Detach/reattach (for background survival)

[Tests: T-TERM-CWD-001, T-TERM-RESIZE-001, T-TERM-DETACH-001, T-TERM-REATTACH-001]

#### **5.4.2 Background survival and lifecycle**

Terminal sessions must continue running when:

* The browser tab is refreshed
* The client disconnects
* The workspace tab is closed (detach semantics)

[Tests: T-REL-RECONNECT-001, T-TAB-004, T-TERM-DETACH-001]

A terminal session must stop only when:

* The user explicitly kills it
* A configured inactivity timeout is reached while it is detached, as defined in settings
* The host service is stopped (in which case the UI must reflect the loss)

[Tests: T-TERM-KILL-001, T-TERM-IDLE-001, T-REL-SERVER-RESTART-001]

#### **5.4.3 Reattach and replay**

When a terminal pane is reattached after disconnect, the pane must receive enough prior output to provide continuity, up to a configured replay buffer size. [Tests: T-TERM-REPLAY-001, T-TERM-REATTACH-001]

If replay data is truncated due to buffer size limits, the UI must indicate that earlier output was truncated. [Tests: T-TERM-REPLAY-002]

#### **5.4.4 Robustness under load**

The product must remain stable when a terminal produces a large volume of output. If output cannot be delivered fast enough, the product must apply backpressure policies without unbounded memory growth and without crashing the host service. [Tests: T-TERM-BACKPRESSURE-001, T-PERF-MEM-001]

### **5.5 Browser panes**

A browser pane must display a URL and allow basic navigation within the pane context (at minimum: setting URL and reloading). [Tests: T-BROW-001, T-BROW-003]

A browser pane must support viewport modes:

* At least one desktop preset
* At least one mobile preset
* A custom width/height mode

[Tests: T-BROW-002]

Changing viewport mode must update the pane’s effective viewport and persist within the workspace state. [Tests: T-BROW-002, T-BROW-RESTORE-001]

When a workspace is closed and reopened, a browser pane must restore, at minimum, its last known URL and viewport mode. [Tests: T-BROW-RESTORE-001]

### **5.6 Provider system for agent CLIs**

#### **5.6.1 Built-in providers**

The product must include built-in provider definitions for:

* Claude Code
* Codex CLI
* Kimi K2.5
* OpenCode

[Tests: T-PROV-CATALOG-001]

Each built-in provider must:

* Appear in a provider catalog UI
* Show an availability status based on whether the underlying CLI is usable on the host
* Be launchable into a terminal pane when available

[Tests: T-PROV-AVAIL-001, T-PROV-LAUNCH-001, T-PROV-LAUNCH-002]

If a built-in provider is not available, the product must clearly indicate why (for example: executable not found) and must not attempt to launch it. [Tests: T-PROV-AVAIL-002]

#### **5.6.2 Declarative provider definitions**

Provider behavior must be describable through configuration, including at minimum:

* Provider identifier and display name
* How to launch the provider in an interactive terminal session (command template, arguments, environment overrides)
* Optional defaults for initial working directory behavior
* Optional session discovery configuration (where to look, and how to interpret entries sufficiently to list sessions)

[Tests: T-PROV-EXT-001, T-PROV-EXT-003, T-HIST-PROV-000]

The product must allow provider configuration to be updated without code changes, and changes must take effect either through a reload action in the UI or by restarting the host service (the product must support at least one of these mechanisms). [Tests: T-PROV-EXT-004]

Invalid provider configurations must not break the entire product; they must be isolated, reported to the user, and other providers must remain usable. [Tests: T-PROV-EXT-002]

#### **5.6.3 Provider-driven session discovery**

The product must support provider session discovery such that the session history view can include sessions from multiple providers concurrently. [Tests: T-HIST-SESSION-001, T-HIST-PROV-001]

For each built-in provider, the product must be able to discover sessions using either the provider’s default storage conventions or explicit user configuration to point at the relevant directories/files. [Tests: T-HIST-PROV-002, T-SET-PROVPATH-001]

### **5.7 Session history**

The session history area must:

* Display sessions from all enabled providers
* Support grouping by project root (or provider-defined project identity)
* Support sorting by recency
* Support filtering by provider and searching by text

[Tests: T-HIST-SESSION-001, T-HIST-GROUP-001, T-HIST-SEARCH-001]

For each session, the product must display:

* Provider identity
* Project identity (name and/or path)
* Last modified time (or equivalent)
* A stable session identifier

[Tests: T-HIST-SESSION-002]

The product must support user overrides for sessions, including:

* Title override
* Description override
* Project color assignment

Overrides must persist across devices and apply consistently wherever the session/project appears. [Tests: T-HIST-OVERRIDE-001, T-HIST-COLOR-001]

Deleting a session from the history UI must be a soft-delete that hides it from default views while preserving recoverability (at minimum via an undo or a “show deleted” view). [Tests: T-HIST-DELETE-001, T-HIST-DELETE-002]

### **5.8 Workspace history**

The workspace history area must list recently closed workspaces, searchable and sortable by recency. [Tests: T-HIST-WORKSPACE-001, T-HIST-WORKSPACE-003]

Each workspace history entry must include enough metadata to help users identify it (name, time closed, and a summary of panes). [Tests: T-HIST-WORKSPACE-004]

Reopening a workspace from history must restore it as an active tab. [Tests: T-HIST-WORKSPACE-005, T-TAB-005]

### **5.9 Settings**

Settings must be persisted on the host and apply to all clients connecting to that host. [Tests: T-SET-001, T-SET-002]

Settings must include, at minimum:

* Default pane configuration for new workspaces (type, and provider if terminal)
* Inactivity timeout for detached terminal sessions
* Limits for maximum background sessions and maximum panes (with safe defaults)
* Provider enable/disable and provider configuration editing/importing
* Keyboard shortcuts configuration (at minimum: tab creation, tab close/detach/kill, pane creation)

[Tests: T-SET-DEFAULTS-001, T-SET-IDLE-001, T-SET-LIMITS-001, T-SET-PROVIDERS-001, T-SET-KEYS-001]

Changes to settings must propagate to existing clients within a bounded time without requiring manual refresh. [Tests: T-SET-003]

### **5.10 Keyboard and touch behavior**

The product must support keyboard-first operation for core workflows:

* Create a new workspace
* Switch workspaces
* Add a pane
* Switch pane focus
* Close/detach a workspace
* Kill a terminal session

[Tests: T-UI-KB-001, T-UI-KB-002, T-UI-KB-003, T-UI-KB-004]

The product must avoid capturing keystrokes intended for terminal panes when a terminal pane is focused, including common control-key combinations used in terminal applications. [Tests: T-UI-KB-005]

On mobile, the product must provide on-screen affordances for actions that otherwise require keyboard shortcuts, including at least:

* Create workspace
* Switch workspace
* Close workspace
* Add pane
* Switch pane focus

[Tests: T-UI-TOUCH-001, T-UI-TOUCH-002]

### **5.11 Security and access control**

When bound to non-loopback interfaces, the product must require authentication for all HTTP routes and real-time connections. [Tests: T-SEC-001, T-AUTH-001]

Authentication must apply uniformly to browser and non-browser clients. [Tests: T-AUTH-002]

The product must enforce a single, consistent authentication mechanism that:

* Does not rely on query parameters for ongoing authorization
* Prevents leaking tokens through browser history or referrer headers after initial processing

[Tests: T-SEC-003, T-SEC-005]

The product must apply rate limiting and connection limiting sufficient to mitigate trivial brute-force and resource exhaustion attacks on exposed endpoints. [Tests: T-SEC-006, T-SEC-007]

### **5.12 Diagnostics and supportability**

The product must provide a diagnostics view (or endpoint accessible in the UI) that includes:

* Product version
* Host OS and key capability flags
* Active terminal sessions and their attachment status
* Recent errors related to providers, process launches, and session discovery

[Tests: T-DIAG-001, T-DIAG-002]

Diagnostic output must not reveal authentication secrets. [Tests: T-DIAG-003]

### **5.13 Quality gates**

A release candidate is acceptable only if all required tests in the appendix pass on the defined OS matrix and in CI, including end-to-end tests that cover terminal panes, browser panes, provider launching, history persistence, reconnect behavior, and security. [Tests: T-QA-001, T-QA-002, T-QA-003]

The product must provide a repeatable, non-interactive test mode suitable for CI that can run without requiring real external agent CLIs by using stub providers and stub CLIs. [Tests: T-QA-004, T-PROV-LAUNCH-003, T-HIST-PROV-003]

## **6. References**

Claude Code Session Organizer implementation plan. 

---

# **Appendix A: Acceptance test matrix**

This appendix defines test IDs referenced throughout the main specification. Tests are written as executable behaviors (Given/When/Then). Implementers may choose any test framework, language, or harness as long as these behaviors are fully automated for the tests marked as required.

Conventions:

* Level:

  * Unit: function/module/component-level behavior
  * Integration: host service + subprocesses + storage + protocol
  * E2E: full product with UI automation

* Required in CI:

  * Yes: must run and pass in CI on supported OS matrix
  * Conditional: runs when prerequisites are present, otherwise skipped with explicit reporting

## **A.1 Boot and lifecycle**

T-BOOT-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Start product and reach main UI

Given the host service is started with a valid configuration
When a client opens the product URL in a browser
Then the main navigation is visible
And the Workspaces area is reachable
And creating a new workspace is possible without errors

T-REL-SERVER-RESTART-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Host restart behavior is explicit

Given a workspace contains a running terminal pane
When the host service is stopped and restarted
And the client reloads the UI
Then the UI shows that the prior terminal session is no longer running
And provides a clear action to create a new terminal pane
And does not display stale “connected” state

## **A.2 OS and shell behaviors**

T-OS-001 (Integration, Required in CI: Yes, Platforms: Windows)
Scenario: Launch default Windows shell terminal

Given the host is Windows
When a terminal pane is created with the default Windows shell
Then the terminal shows an interactive prompt
And accepts input
And produces output

T-OS-002 (Integration, Required in CI: Yes, Platforms: macOS)
Scenario: Launch system shell terminal on macOS

Given the host is macOS
When a terminal pane is created with the system shell selection
Then the terminal shows an interactive prompt
And accepts input
And produces output

T-OS-003 (Integration, Required in CI: Yes, Platforms: Linux)
Scenario: Launch system shell terminal on Linux

Given the host is Linux
When a terminal pane is created with the system shell selection
Then the terminal shows an interactive prompt
And accepts input
And produces output

T-TERM-SHELL-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Shell selection errors are surfaced

Given a terminal pane creation request specifies a non-existent shell executable
When the terminal pane is created
Then the creation fails
And the UI shows an error explaining the failure
And the user can retry with a different shell

T-TERM-CWD-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Working directory set on terminal creation

Given a directory exists on the host filesystem
When a terminal pane is created with that directory as its initial working directory
Then executing a command that prints the current directory shows the configured path

## **A.3 Authentication and security**

T-SEC-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Remote bind requires auth

Given the host service is configured to bind to a non-loopback interface
When authentication is not configured
Then the host service refuses to start or refuses the non-loopback bind
And logs a clear reason

T-SEC-002 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: HTTP requires auth when remote-access mode enabled

Given the host service is in remote-access mode with auth configured
When an unauthenticated HTTP request is made to a protected endpoint
Then the response is an authentication failure
And no protected data is returned

T-AUTH-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Auth succeeds with correct credentials

Given auth is configured
When a request is made with valid credentials
Then the request succeeds
And returns expected content

T-AUTH-002 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Real-time connection requires auth

Given auth is configured
When a client establishes a real-time connection without valid credentials
Then the connection is rejected
And the client receives a clear auth failure signal

T-SEC-003 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Token is not persisted and is removed from URL

Given a client authenticates using an initial token entry mechanism
When the UI finishes authentication
Then the browser URL does not contain the token
And the token is not present in persistent browser storage

T-SEC-004 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Same-origin and referrer behavior is safe

Given the product is served from a host URL
When the UI navigates within the product
Then the product does not emit referrers containing secrets
And protected endpoints are only reachable with auth

T-SEC-005 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: No query-param auth for ongoing requests

Given auth is configured
When a client attempts to access protected endpoints with only query parameters
Then access is denied

T-SEC-006 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Rate limiting on auth failures

Given auth is configured
When repeated invalid auth attempts exceed the configured threshold
Then further attempts are throttled for a time window
And valid attempts still succeed after throttling resets

T-SEC-007 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Connection limiting

Given the host service has a configured max connection limit
When more clients attempt to connect concurrently than the limit
Then excess connections are rejected deterministically
And existing connections remain stable

## **A.4 Workspaces and tabs**

T-TAB-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: New workspace opens with default pane

Given the default pane setting is terminal
When the user creates a new workspace
Then exactly one pane exists
And it is a terminal pane
And it is focused

Repeat with default pane set to browser. The first pane must be a browser pane.

T-TAB-002 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Rename workspace

Given a workspace exists
When the user renames the workspace
Then the new name is visible in the tab bar
And persists across reload

T-TAB-003 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Switch workspaces

Given two workspaces exist
When the user switches to the other workspace
Then the active workspace changes
And the previously active workspace remains intact

T-TAB-004 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Close workspace detaches by default

Given a workspace has one terminal pane running a long-lived command
When the user closes the workspace tab via the default close action
Then the workspace is removed from active tabs
And the underlying terminal process continues running in background
And the workspace appears in workspace history

T-TAB-005 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Reopen closed workspace restores panes

Given a workspace is closed and appears in workspace history
When the user reopens it
Then the workspace reappears as an active tab
And the previous pane layout is restored
And any still-running terminal processes are reattached

T-TAB-PROJECTROOT-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Workspace project root determination

Given a new workspace is created from a specified directory
When the workspace is created
Then the workspace project root equals that directory
And is used for grouping and color resolution

T-TAB-RESTORE-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Restore active workspaces after reload

Given two workspaces exist with multiple panes
When the client reloads the page
Then the same workspaces are present
And each pane is restored
And terminals reattach when possible

## **A.5 Panes and layout**

T-PANE-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Add terminal pane

Given a workspace exists
When the user adds a terminal pane
Then the workspace pane count increases by one
And the new terminal pane is interactive

T-PANE-002 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Add browser pane

Given a workspace exists
When the user adds a browser pane
Then the workspace pane count increases by one
And the browser pane can be navigated to a URL

T-PANE-003 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Multiple panes run concurrently

Given a workspace has 2 terminal panes and 1 browser pane
When a long-lived process runs in one terminal
And interactive commands run in the other terminal
Then both terminals remain responsive
And the browser pane remains usable

T-PANE-004 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Split and resize panes

Given a workspace has two panes in a split layout
When the user resizes the split
Then both panes resize
And terminal panes receive correct resize events

T-PANE-005 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Pane focus switching

Given a workspace with multiple panes
When the user switches focus to another pane
Then keyboard input goes to the focused pane
And terminal panes do not receive input when unfocused

T-PANE-006 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Rearrange panes

Given a workspace with at least 3 panes
When the user moves a pane within the layout
Then the pane remains functional
And the layout persists across reload

T-PANE-007 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Close a pane

Given a workspace has a terminal pane
When the user closes that pane with default close semantics
Then the pane is removed from the layout
And the terminal process is detached (not killed) unless explicitly killed

T-PANE-008 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Kill a terminal pane explicitly

Given a terminal pane is running a command
When the user chooses the explicit kill action for that pane
Then the process terminates
And the UI shows the terminal is ended

T-PANE-009 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Pane identifiers are stable within a workspace

Given a workspace state is persisted
When it is reloaded
Then pane identifiers remain stable for restored panes

T-PANE-010 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Support at least 8 panes in one workspace

Given a workspace exists
When the user adds panes until there are 8 panes (mixed types)
Then all panes remain usable
And no UI or host-service error occurs

T-PANE-RESTORE-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Pane state restoration on workspace reopen

Given a workspace contains 2 terminals and 1 browser pane with a URL and viewport preset
When the workspace is closed and later reopened
Then the browser pane restores URL and viewport preset
And terminals attempt to reattach

## **A.6 Terminal pane behaviors**

T-TERM-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Basic terminal I/O

Given a terminal pane is created
When the user types a command that prints a known string
Then the output contains that string

T-TERM-002 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Terminal supports interactive programs

Given a terminal pane is created
When a simple interactive program is run (reads input, prints transformed output)
Then round-trip interaction works correctly

T-TERM-RESIZE-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Resize signal propagates

Given a terminal pane is visible
When its pane is resized
Then the terminal receives the new size
And applications that query terminal size observe the update

T-TERM-DETACH-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Detach keeps process running

Given a terminal pane is running a long-lived command that writes a heartbeat output periodically
When the pane is detached (workspace closed or pane closed with detach semantics)
Then the process continues producing output in the background
And reattachment shows continued progress

T-TERM-REATTACH-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Reattach to existing terminal

Given a terminal exists and is detached
When a new pane attaches to it
Then the terminal becomes interactive again
And new input produces output

T-TERM-REPLAY-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Replay provides continuity after reconnect

Given a terminal produced output before disconnect
When the client disconnects and reconnects
And reattaches to the terminal
Then the pane receives replay output up to the configured buffer size
And subsequent live output continues

T-TERM-REPLAY-002 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Replay truncation is visible

Given replay buffer size is configured small
And the terminal produces output larger than the buffer
When the client reconnects and reattaches
Then the UI indicates that earlier output was truncated

T-TERM-ROUTING-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Output never crosses terminal boundaries

Given two terminal panes exist
When each terminal prints a unique marker repeatedly
Then each marker appears only in its originating pane
Including across tab switches and reconnects

T-TERM-KILL-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Kill terminates process

Given a terminal is running
When kill is invoked
Then the process terminates
And further input is rejected
And the UI shows an ended state

T-TERM-IDLE-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Inactivity timeout kills detached terminals

Given inactivity timeout is set to a short duration
And a terminal is detached with no attached clients
When the timeout duration elapses without activity
Then the terminal is terminated
And the history/diagnostics reflect that it ended due to inactivity

T-TERM-BACKPRESSURE-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Backpressure does not crash and does not grow memory unbounded

Given a terminal emits output at a high rate
When the client reads slowly or pauses
Then the host service remains stable
And memory usage does not grow without bound
And the UI indicates output loss or truncation per policy

## **A.7 Browser pane behaviors**

T-BROW-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Load URL in browser pane

Given a browser pane exists
When the user navigates to a reachable URL
Then the page content is displayed in the pane

T-BROW-002 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Viewport presets and custom size

Given a browser pane exists
When the user selects a desktop preset
Then the effective viewport reflects that preset
When the user selects a mobile preset
Then the effective viewport reflects that preset
When the user sets a custom width/height
Then the effective viewport reflects that custom size

T-BROW-003 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Reload in browser pane

Given a browser pane is showing a page that changes content on reload
When the user reloads
Then the updated content is displayed

T-BROW-RESTORE-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Restore browser pane URL and viewport

Given a browser pane is set to a specific URL and viewport preset
When the workspace is closed and reopened
Then the pane restores the URL and viewport preset

## **A.8 Provider catalog and extensibility**

T-PROV-CATALOG-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Built-in providers are listed

Given the product is running
When the user opens the provider catalog in settings
Then providers named Claude Code, Codex CLI, Kimi K2.5, and OpenCode are listed

T-PROV-AVAIL-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Provider availability detection

Given a provider is configured with an executable that exists
Then the provider is marked available
Given a provider is configured with an executable that does not exist
Then the provider is marked unavailable
And a reason is recorded

T-PROV-AVAIL-002 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Unavailable provider cannot be launched

Given a provider is marked unavailable
When the user attempts to launch it
Then the launch is blocked
And a clear error message is shown

T-PROV-LAUNCH-001 (E2E, Required in CI: Conditional, Platforms: Win/macOS/Linux)
Scenario: Launch built-in provider into terminal pane when installed

Given a built-in provider’s CLI is installed and available
When the user launches that provider into a new terminal pane
Then the pane becomes interactive
And provider startup output appears

T-PROV-LAUNCH-002 (E2E, Required in CI: Conditional, Platforms: Win/macOS/Linux)
Scenario: Launch provider with configured working directory

Given a provider is configured with a working directory rule
When launched in a workspace with a project root
Then the provider is launched using the correct working directory

T-PROV-LAUNCH-003 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Launch using stub CLI (CI-safe)

Given a stub CLI executable is provided by the test harness
And a provider definition points to that stub
When launched into a terminal pane
Then the stub prompt appears
And test input produces deterministic test output

T-PROV-EXT-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Add new provider via configuration without code changes

Given the product loads provider definitions from configuration
When a new provider definition is added that points to a stub CLI
And the product reloads provider definitions (or is restarted)
Then the provider appears in the catalog
And can be launched successfully

T-PROV-EXT-002 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Invalid provider definition is isolated

Given a provider definition is malformed or invalid
When provider definitions are loaded
Then that provider is marked invalid
And an error is shown in settings
And other providers still load and function

T-PROV-EXT-003 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Enable/disable provider

Given a provider exists
When the user disables it
Then it does not appear in launch menus
When the user re-enables it
Then it reappears

T-PROV-EXT-004 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Provider definition change takes effect

Given a provider exists
When its launch arguments are changed in configuration
And provider definitions are reloaded
Then a subsequent launch uses the updated arguments

## **A.9 Provider session discovery and history**

T-HIST-PROV-000 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Provider discovery pipeline is pluggable by configuration

Given a provider definition includes discovery configuration
When the discovery scan runs
Then sessions are discovered from the configured locations
And errors are reported per-provider without failing the scan globally

T-HIST-SESSION-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: History shows sessions from multiple providers

Given fixtures exist for at least two providers
When the user opens session history
Then sessions from both providers are listed
And each entry shows provider identity

T-HIST-SESSION-002 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Session entry includes required metadata

Given session history is populated
Then each entry shows a stable session identifier, provider, project identity, and recency information

T-HIST-GROUP-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Group by project

Given sessions exist for multiple projects
When the history view groups by project
Then sessions are grouped correctly
And group headers include project identity

T-HIST-SEARCH-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Search and filter

Given history contains entries with different providers and text metadata
When the user searches by text
Then only matching entries remain
When the user filters by provider
Then only that provider’s entries remain

T-HIST-OVERRIDE-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Title/description overrides persist

Given a session entry exists
When the user sets a title override and description override
Then the overrides are displayed in history
And persist across reload and from a second client device

T-HIST-COLOR-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Project colors persist and apply

Given a project appears in history
When the user assigns a project color
Then the color is shown anywhere that project is represented
And persists across reload and from a second client

T-HIST-DELETE-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Soft delete hides by default

Given a session entry exists
When the user deletes the entry
Then it no longer appears in default history view
And does not reappear after reload

T-HIST-DELETE-002 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Deleted entries are recoverable

Given a session entry has been deleted
When the user enables “show deleted” (or equivalent recovery UI)
Then the deleted entry is visible
And can be restored to default view

T-HIST-PROV-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Each built-in provider can discover sessions via configured roots

Given fixture session artifacts exist for each built-in provider
When provider roots are configured to point at those fixtures
Then sessions are discovered and correctly labeled by provider

T-HIST-PROV-002 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Misconfigured discovery path is handled

Given a provider discovery path does not exist
When discovery runs
Then the provider shows an actionable warning
And discovery for other providers still succeeds

T-HIST-PROV-003 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Discovery works in CI without real CLIs

Given only fixture files exist and no real CLIs are installed
When discovery runs
Then history is populated from fixtures
And provider launch tests use stub CLIs

## **A.10 Workspace history**

T-HIST-WORKSPACE-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Closing creates restorable workspace history entry

Given a workspace with multiple panes exists
When the workspace is closed
Then it appears in workspace history with correct name and timestamp
And a pane summary is shown

T-HIST-WORKSPACE-002 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Reopen last closed workspace

Given the user closes a workspace
When the user triggers “reopen last closed workspace”
Then the workspace is restored as an active tab

T-HIST-WORKSPACE-003 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Workspace history search

Given multiple workspace history entries exist
When the user searches by workspace name
Then only matching entries appear

T-HIST-WORKSPACE-004 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Workspace history pane summary

Given a workspace history entry exists for a workspace with mixed panes
Then the entry’s summary indicates the count of terminal and browser panes

T-HIST-WORKSPACE-005 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Reopen restores pane layout and state

Given a closed workspace contains 2 terminals and 2 browsers with different viewport presets
When reopened
Then layout is restored
And browser URL/viewport are restored
And terminals attempt reattach

## **A.11 Settings**

T-SET-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Settings persist on host and apply across clients

Given the user changes a setting from one client
When a second client connects
Then the second client reflects the updated setting without manual steps

T-SET-002 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Settings survive reload

Given settings are changed
When the UI reloads
Then settings remain applied

T-SET-DEFAULTS-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Default pane controls new workspace

Given default pane is set to browser with a specific default URL
When creating a new workspace
Then the first pane is a browser pane
And its URL matches the configured default

Repeat with default pane set to a specific provider terminal.

T-SET-IDLE-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Inactivity timeout setting is enforced

Given inactivity timeout is set to N minutes
When a detached terminal remains idle for more than N minutes
Then it is terminated

T-SET-LIMITS-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Pane/session limits are enforced with clear errors

Given max panes per workspace is set to N
When attempting to add pane N+1
Then the operation is blocked
And the user sees a clear message

T-SET-PROVIDERS-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Provider enable/disable and edit is available

Given providers exist
When the user disables a provider
Then it is not offered in launch UI
When the user edits its configuration
Then the updated configuration is reflected after reload/restart mechanism

T-SET-PROVPATH-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Provider discovery roots configurable

Given a provider has a configurable discovery root
When the root is changed to point at fixture artifacts
Then discovery reflects sessions from the new root

T-SET-KEYS-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Keybinding customization

Given keybindings are configurable
When the user changes a keybinding for “new workspace”
Then the new binding triggers the action
And the old binding does not

T-SET-003 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Settings propagate to other clients

Given two clients are connected
When one client changes default pane setting
Then the other client sees the updated default in settings UI within a bounded time

## **A.12 Reconnect robustness**

T-REL-RECONNECT-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Disconnect and reconnect restores sessions

Given a workspace has a running terminal pane
When the client connection is interrupted
And later restored
Then the terminal pane reattaches automatically
And new input still works

T-REL-INPUT-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Input during disconnect is not silently lost

Given a terminal pane exists
When the client is disconnected
And the user attempts to type into the terminal
Then the UI indicates input is not currently deliverable or queues it
And after reconnect, either the queued input is delivered or the UI indicates it was discarded

## **A.13 UI keyboard and touch**

T-UI-NAV-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Navigate all top-level areas

Given the UI is open
When the user navigates to Workspaces, Session History, Workspace History, Settings, and Diagnostics
Then each area loads without error

T-UI-KB-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Keyboard can create workspace

Given the UI is open
When the user uses the configured keyboard shortcut for new workspace
Then a new workspace is created

T-UI-KB-002 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Keyboard can switch workspaces and panes

Given multiple workspaces and panes exist
When the user uses keyboard controls for switching
Then focus changes correctly

T-UI-KB-003 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Keyboard can add pane

Given a workspace exists
When the user triggers “add pane” via keyboard
Then a pane is added

T-UI-KB-004 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Keyboard can close/detach workspace and kill terminal

Given a workspace exists with a running terminal
When the user triggers close/detach workspace via keyboard
Then it closes with detach semantics
When the user triggers explicit kill for the terminal
Then it terminates

T-UI-KB-005 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Global shortcuts do not interfere with terminal focused input

Given a terminal pane is focused
When the user types common control-key sequences used by terminal applications
Then they are delivered to the terminal and not intercepted by the UI

T-UI-KB-006 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Reopen last closed workspace via keyboard

Given a workspace is closed
When the user triggers “reopen last closed workspace” via keyboard
Then the workspace is restored

T-UI-TOUCH-001 (E2E, Required in CI: Conditional, Platforms: Win/macOS/Linux)
Scenario: Mobile on-screen controls exist for core actions

Given the UI is rendered in a small viewport
Then there are on-screen controls to create a workspace, switch workspaces, close workspace, add pane, and change pane focus

T-UI-TOUCH-002 (E2E, Required in CI: Conditional, Platforms: Win/macOS/Linux)
Scenario: Touch interaction works with terminal and browser panes

Given the UI is rendered in a small viewport
When the user taps to focus a terminal pane
Then the terminal accepts input via the virtual keyboard
When the user taps in a browser pane
Then the browser pane responds to scroll and click/tap

## **A.14 Diagnostics**

T-DIAG-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Diagnostics view shows version and capabilities

Given the UI is open
When the user opens diagnostics
Then product version is shown
And host OS is shown
And provider availability summary is shown

T-DIAG-002 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Diagnostics lists active sessions

Given terminal sessions exist
When diagnostics is opened
Then it lists active terminal sessions
And indicates which are attached/detached

T-DIAG-003 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Diagnostics do not reveal secrets

Given authentication is configured
When diagnostics is opened
Then no auth tokens appear anywhere in diagnostics output

## **A.15 Performance and resource bounds**

T-PERF-MEM-001 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: No unbounded memory growth under terminal output load

Given a terminal emits output continuously for a fixed duration
When the client reads slowly or is disconnected
Then host memory usage remains within a bounded envelope
And does not show monotonic unbounded growth

T-PERF-SCALE-001 (E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Scale to baseline concurrency

Given the product is running
When the test creates 10 workspaces
And each workspace contains 3 panes (2 terminals, 1 browser)
Then the product remains responsive
And no crashes occur
And all terminals accept input and produce output

## **A.16 Quality gates**

T-QA-001 (Meta/E2E, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Full suite passes on OS matrix

Given CI runs on Windows, macOS, and Linux
When the full required suite runs
Then all tests marked “Required in CI: Yes” pass

T-QA-002 (Meta, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Deterministic E2E coverage

Given CI runs the E2E suite
Then the suite does not require network access to external services
And does not depend on human interaction
And uses stub CLIs where necessary

T-QA-003 (Meta, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Test reporting is complete

Given CI runs
When a test is skipped due to missing prerequisites
Then the skip is explicit in reports
And includes the reason and prerequisite

T-QA-004 (Integration, Required in CI: Yes, Platforms: Win/macOS/Linux)
Scenario: Non-interactive test mode exists

Given CI runs in headless mode
When the product is started in test mode
Then it can create terminals, use stub providers, discover fixture sessions, and run E2E UI automation without manual configuration
