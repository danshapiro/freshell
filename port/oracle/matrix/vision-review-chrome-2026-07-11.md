# Vision review (s8.4) — Chromium matrix batches, 2026-07-11

Reviewer: skeptical vision model via image-vision skill (anthropic/openai fallback).

## Batch: sbp9-orig-chrome

### sbp9-orig-chrome-cmd.png (md5 7dff5ae7)

VERDICT: PASS

The terminal pane displays a cmd.exe session that shows the documented defective-original behavior. The output clearly shows "UNC paths are not supported. Defaulting to Windows directory." followed by "The filename, directory name, or volume label syntax is incorrect." The prompt falls back to C:\Windows> (not the expected freshell-matrix directory), and the command "echo freshell-matrix-OK" successfully executes with output "freshell-matrix-OK". This matches the SPECIAL CASE documented defect exactly.

### sbp9-orig-chrome-powershell.png (md5 61ef0639)

VERDICT: PASS

The screenshot shows a PowerShell terminal pane with the expected prompt "PS C:\Users\Public\freshell-matrix-ws-sbp9-orig-chrome-uzvuk5a5>" clearly visible. The command "echo freshell-matrix-OK" has been executed and its output "freshell-matrix-OK" is displayed on the following line. The working directory is correctly set to C:\Users\Public\freshell-matrix-ws-sbp9-orig-chrome-uzvuk5a5, not C:\Windows, and the terminal is actively showing a ready prompt cursor.

### sbp9-orig-chrome-wsl.png (md5 3faed92c)

VERDICT: PASS

The terminal pane clearly displays a WSL/Ubuntu bash session with the expected command outputs. The `uname -a` command output is visible showing "Linux SurfaceBookPro9 6.6.87.2-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC Thu Jun 5 18:30:46 UTC 2025 x86_64 x8_64 64 x86_64 x86_64 GNU/Linux". The `echo freshell-matrix-OK && pwd` command execution is shown with the output "freshell-matrix-OK" followed by the working directory path "/mnt/c/Users/Public/freshell-matrix-ws-sbp9-orig-chrome-uzvuk5a5". The terminal is functioning properly with no blank areas, error dialogs, or authentication walls blocking the interface.

### sbp9-orig-chrome-editor.png (md5 2b8f3f33)

VERDICT: PASS

The screenshot shows a Monaco code editor pane displaying a Rust source file named "freshell-matrix.rs". The code is clearly visible with syntax highlighting, showing a main function that prints "freshell matrix editor OK". The first line contains a comment "// freshell-matrix-OK — freshell editor scratch pad". The code structure is properly formatted with colored syntax (green for comments, blue for keywords like "fn", red for strings).

### sbp9-orig-chrome-browser.png (md5 62841f15)

VERDICT: PASS

The screenshot shows a freshell terminal-multiplexer application with an embedded browser pane successfully rendering the Example Domain page from http://example.com. The main content area clearly displays the "Example Domain" heading in large text, followed by the paragraph "This domain is for use in documentation examples without needing permission. Avoid use in operations." and a "Learn more" link below it. The browser chrome shows the correct URL and the page has loaded completely without any errors or blocking elements.

### sbp9-orig-chrome-claude.png (md5 fd1c448e)

VERDICT: PASS

The screenshot clearly shows the Claude Code CLI v2.1.207 welcome screen fully rendered in the terminal pane. The welcome banner includes ASCII art of the Claude logo and a pixel character, followed by "Let's get started." text. The interface displays a theme selection menu with 7 options (Auto, Dark mode ✓, Light mode, etc.), and below that shows a code diff example with syntax highlighting comparing "Hello, World!" to "Hello, Claude!". The syntax theme note "Monokai Extended (ctrl+t to disable)" is visible at the bottom. No blank areas, errors, or authentication barriers are present.

### sbp9-orig-chrome-codex.png (md5 e8166358)

VERDICT: PASS

The screenshot clearly shows the Codex CLI welcome screen rendered in a terminal pane. The ASCII art logo is visible at the top, followed by "Welcome to Codex, OpenAI's command-line coding agent". Three sign-in options are displayed: "1. Sign in with ChatGPT" (selected, shown with ">"), "2. Sign in with Device Code", and "3. Provide your own API key". The prompt "Press enter to continue" is visible at the bottom. This is the expected first screen of the Codex CLI interface, not an authentication wall or error state.

### sbp9-orig-chrome-opencode.png (md5 5c1f37c5)

VERDICT: PASS

The screenshot clearly shows the OpenCode TUI rendered in the terminal pane. The distinctive "opencode" logo/banner is visible at the top of the pane, followed by an "Ask anything... 'Fix broken tests'" input box and "Build · GPT-5 OpenAI" model information. The interface elements including "tab agents" and "ctrl+p commands" options are present at the bottom right of the pane, confirming the OpenCode application has successfully loaded and rendered.

### sbp9-orig-chrome-overview.png (md5 a0d4380d)

VERDICT: PASS

The screenshot shows the freshell terminal-multiplexer web app with a clear tab strip at the top containing multiple tabs including "New Tab", "C:\Windo..." (multiple instances), "freshell-m...", "Tab", "example...", and "freshell-m...". The active terminal pane displays Windows command prompt output showing a WSL localhost path error message, followed by successful echo commands outputting "freshell-matrix-OK". The terminal is fully functional and rendering content properly with visible prompts at "C:\Windows>".


## Batch: sbp9-wsl-chrome

### sbp9-wsl-chrome-cmd.png (md5 0eaa1120)

VERDICT: PASS

The screenshot shows a freshell terminal interface with a cmd.exe session actively running. The prompt displays `C:\Users\Public\freshell-matrix-ws-sbp9-wsl-chrome-nj2891ij>` which matches the expected directory pattern. The command `echo freshell-matrix-OK` has been executed and the output `freshell-matrix-OK` is clearly visible on the line below. The terminal pane is functioning properly with rendered content, no errors, and the correct working directory.

### sbp9-wsl-chrome-powershell.png (md5 7933dde3)

VERDICT: PASS

The screenshot shows a PowerShell terminal pane with the expected prompt "PS C:\Users\Public\freshell-matrix-ws-sbp9-wsl-chrome-nj2891ij>" visible. The command "echo freshell-matrix-OK" has been executed and its output "freshell-matrix-OK" is displayed on the following line. The current working directory is correctly set to C:\Users\Public\freshell-matrix-ws-sbp9-wsl-chrome-nj2891ij, not C:\Windows, and the terminal is functional with no errors or blocking elements visible.

### sbp9-wsl-chrome-wsl.png (md5 b88713ee)

VERDICT: PASS

The terminal pane clearly shows a WSL Ubuntu 24.04.3 LTS session with visible command execution. The `uname -a` command output is displayed showing "sLinux SurfaceBookPro9 6.6.87.2-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC Thu Jun 5 18:30:46 UTC 2025 x86_64 x86_64 x86_64 GNU/Linux". Below that, the command `echo freshell-matrix-OK && pwd` is executed with the output "freshell-matrix-OK" visible, followed by the working directory path "/mnt/c/Users/Public/freshell-matrix-ws-sbp9-wsl-chrome-nj2891ij". The terminal is fully functional and displaying the expected content without any blocking errors or blank areas.

### sbp9-wsl-chrome-editor.png (md5 79598112)

VERDICT: PASS

The screenshot shows a Monaco code editor pane displaying a Rust source file named "freshell-matrix.rs". The code is clearly visible with syntax highlighting, showing a main function that prints "freshell matrix editor OK". The comment on line 1 reads "// freshell-matrix-OK — freshell editor scratch pad", and the code includes proper Rust syntax coloring with keywords like `fn`, `main()`, and `println!` appropriately highlighted. The editor interface is fully functional and displaying the expected content.

### sbp9-wsl-chrome-browser.png (md5 62841f15)

VERDICT: PASS

The screenshot shows the freshell terminal-multiplexer web app with an embedded browser pane successfully rendering the example.com page. The browser displays the distinctive "Example Domain" heading in large text, followed by the explanatory paragraph "This domain is for use in documentation examples without needing permission. Avoid use in operations." and a "Learn more" link. The URL bar shows "http://example.com" and the page content is fully visible and properly rendered.

### sbp9-wsl-chrome-claude.png (md5 9481a8a1)

VERDICT: PASS

The screenshot shows a freshell terminal multiplexer displaying the Claude Code v2.1.207 welcome screen. The welcome banner is fully rendered with ASCII art including the Claude logo and a space invader character. Below the banner is a complete interactive setup wizard asking the user to "Choose the text style that looks best with your terminal" with 7 numbered options (Auto, Dark mode ✓, Light mode, etc.). At the bottom, there's a code diff showing a function with syntax highlighting (red and green lines) and a note about the Monokai Extended syntax theme. The TUI is fully painted and functional with no errors, blank areas, or authentication walls visible.

### sbp9-wsl-chrome-codex.png (md5 7cb857e0)

VERDICT: PASS

The screenshot shows a terminal pane displaying the Codex CLI welcome screen. The banner clearly reads "Welcome to Codex, OpenAI's command-line coding agent" followed by authentication instructions. Three numbered sign-in options are visible: "1. Sign in with ChatGPT" (with usage plans listed), "2. Sign in with Device Code" (with explanation text), and "3. Provide your own API key" (with "Pay for what you use" subtext). The prompt "Press enter to continue" appears at the bottom. This is the expected Codex CLI first-run screen, not a blocking auth wall.

### sbp9-wsl-chrome-opencode.png (md5 cfe5f32a)

VERDICT: PASS

The screenshot shows the OpenCode TUI successfully rendered in the terminal pane. The OpenCode banner logo is clearly visible at the top in ASCII art style. Below that is the "Ask anything..." prompt with placeholder text "What is the tech stack of this project?" and the model selection showing "Build · GPT-5.3 Chat (latest) OpenAI". The terminal path "/mnt/c/Users/Public/freshell-matrix-ws-sbp9-wsl-chrome-nj2891ij" is displayed at the bottom with the IP "17.18", confirming an active terminal session.

### sbp9-wsl-chrome-overview.png (md5 24c71aca)

VERDICT: PASS

The freshell terminal multiplexer UI is fully visible with a tab strip at the top containing multiple tabs including "New Tab", "C:\Windo...", "freshell-m...", "Tab", "example...", and "freshell-m...". The active terminal pane displays a Windows command prompt showing the path "C:\Users\Public\freshell-matrix-ws-sbp9-wsl-chrome-nj2891ij>" with command output "echo freshell-matrix-OK" and "freshell-matrix-OK" visible. The left sidebar shows "No sessions yet" but the main terminal area is functioning and displaying content as expected.


## Batch: sbp9-win-chrome

### sbp9-win-chrome-cmd.png (md5 5a8b0818)

VERDICT: PASS

The screenshot shows a freshell terminal web app with a cmd.exe session clearly visible. The terminal pane displays the correct working directory `C:\Users\Public\freshell-matrix-ws-02whhju>` and shows the executed command `echo freshell-matrix-OK` with its corresponding output `freshell-matrix-OK` printed below. The prompt is currently awaiting the next command, confirming the terminal is functional and in the expected directory structure.

### sbp9-win-chrome-powershell.png (md5 8deb3cef)

VERDICT: PASS

The screenshot shows a PowerShell terminal pane with the expected prompt "PS C:\Users\Public\freshell-matrix-ws-02whhjub>" visible. The command "echo freshell-matrix-OK" has been executed and its output "freshell-matrix-OK" is displayed directly below the command line. The current working directory is correctly set to C:\Users\Public\freshell-matrix-ws-02whhjub, not C:\Windows, meeting the requirements.

### sbp9-win-chrome-wsl.png (md5 b04f60e8)

VERDICT: PASS

The terminal pane clearly displays the expected content. The prompt shows `dan@SurfaceBookPro9:/mnt/c/Users/Public/freshell-matrix-ws-02whhjub$` with two executed commands visible. The first command `echo freshell-matrix-OK && uname -a` shows output "freshell-matrix-OK" followed by Linux kernel information (Linux SurfaceBookPro9 6.6.87.2-microsoft-standard-WSL2). The second command prompt is ready for input. The working directory path matches the expected freshell-matrix workspace location in /mnt/c/Users/Public/, confirming WSL2 environment and proper terminal functionality.

### sbp9-win-chrome-editor.png (md5 d314c278)

VERDICT: PASS

The screenshot shows a Monaco code editor pane displaying Rust code with proper syntax highlighting. The visible code contains a comment "// freshell-matrix-OK - freshell editor scratch pad" followed by a main function with a println! statement that outputs "freshell matrix editor OK". The code is clearly rendered with syntax coloring (orange/rust-colored keywords and green strings are visible), and the file tab shows "freshell-matrix.rs" as the active file. The editor content is fully visible and matches the expected freshell matrix editor code snippet.

### sbp9-win-chrome-browser.png (md5 8b157a08)

VERDICT: PASS

The screenshot shows a terminal-multiplexer application called "freshell" with an embedded browser pane displaying the Example Domain page. The browser clearly renders the heading "Example Domain" and the paragraph text "This domain is for use in documentation examples without needing permission. Avoid use in operations." along with a "Learn more" link. The URL bar shows "http://example.com" and the page content is fully visible and properly rendered.

### sbp9-win-chrome-claude.png (md5 83952cbd)

VERDICT: PASS

The screenshot shows the Claude Code CLI interactive TUI successfully rendered in the terminal pane. The interface displays a clear "Accessing workspace:" header followed by the workspace path "C:\Users\Public\freshell-matrix-ws-02whhjub". A formatted security prompt is visible with a "Quick safety check" message, two numbered options ("1. Yes, I trust this folder" and "2. No, exit"), and instruction text "Enter to confirm · Esc to cancel" at the bottom. The TUI includes proper formatting with the security guide section and interactive selection indicators.

### sbp9-win-chrome-codex.png (md5 0d0f382f)

VERDICT: PASS

The screenshot shows a terminal pane displaying a trust prompt for the directory "C:\Users\Public\freshell-matrix-ws-02whhjub". The prompt asks "Do you trust the contents of this directory?" with two options clearly visible: "1. Yes, continue" and "2. No, quit". Below that is instruction text "Press enter to continue and create a sandbox...". This is the expected Codex CLI trust prompt interface, which is one of the valid first screens described in the requirements. The content is fully rendered and interactive, not blank or showing errors.

### sbp9-win-chrome-opencode.png
MISSING (not part of this leg)

### sbp9-win-chrome-overview.png (md5 8f05bb4c)

VERDICT: PASS

The screenshot shows the freshell terminal multiplexer web app with a visible tab strip containing multiple tabs including "New Tab", "C:\Windo...", "dan@Surf...", "Tab", "example...", and "freshell-m...". The active terminal pane displays a Windows command prompt at path "C:\Users\Public\freshell-matrix-ws-02whhjub>" with visible command output showing "freshell-matrix-OK" echoed twice. The left sidebar shows "No sessions yet" but the main terminal area is functional and displaying content as expected.

DONE_ALL
