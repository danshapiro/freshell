import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createAgentApiRouter } from "../../server/agent-api/router";

class FakeRegistry {
  create = vi.fn(() => ({ terminalId: "term_1" }));
}

describe("tab endpoints", () => {
  it("creates a new tab and returns ids", async () => {
    const app = express();
    app.use(express.json());
    const layoutStore = {
      createTab: () => ({ tabId: "tab_1", paneId: "pane_1" }),
      attachPaneContent: () => {},
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: "tab_1" }),
      selectPrevTab: () => ({ tabId: "tab_1" }),
    };
    app.use(
      "/api",
      createAgentApiRouter({
        layoutStore,
        registry: new FakeRegistry(),
        wsHandler: { broadcastUiCommand: () => {} },
      }),
    );
    const res = await request(app).post("/api/tabs").send({ name: "alpha" });
    expect(res.body.status).toBe("ok");
    expect(res.body.data.tabId).toBe("tab_1");
  });

  it("creates browser tabs without spawning a terminal", async () => {
    const app = express();
    app.use(express.json());
    const registry = new FakeRegistry();
    const createTab = vi.fn(() => ({ tabId: "tab_1", paneId: "pane_1" }));
    const layoutStore = {
      createTab,
      attachPaneContent: vi.fn(),
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: "tab_1" }),
      selectPrevTab: () => ({ tabId: "tab_1" }),
    };
    app.use(
      "/api",
      createAgentApiRouter({
        layoutStore,
        registry,
        wsHandler: { broadcastUiCommand: () => {} },
      }),
    );
    const res = await request(app)
      .post("/api/tabs")
      .send({ name: "web", browser: "https://example.com" });

    expect(res.body.status).toBe("ok");
    expect(createTab).toHaveBeenCalled();
    expect(registry.create).not.toHaveBeenCalled();
    expect(layoutStore.attachPaneContent).toHaveBeenCalled();
  });

  it("allocates and passes an OpenCode control endpoint when creating an opencode tab", async () => {
    const app = express();
    app.use(express.json());
    const registry = new FakeRegistry();
    const layoutStore = {
      createTab: () => ({ tabId: "tab_1", paneId: "pane_1" }),
      attachPaneContent: () => {},
      selectTab: () => ({}),
      renameTab: () => ({}),
      closeTab: () => ({}),
      hasTab: () => true,
      selectNextTab: () => ({ tabId: "tab_1" }),
      selectPrevTab: () => ({ tabId: "tab_1" }),
    };
    app.use(
      "/api",
      createAgentApiRouter({
        layoutStore,
        registry,
        wsHandler: { broadcastUiCommand: () => {} },
      }),
    );

    const res = await request(app)
      .post("/api/tabs")
      .send({ mode: "opencode", name: "OpenCode" });

    expect(res.body.status).toBe("ok");
    expect(registry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "opencode",
        providerSettings: expect.objectContaining({
          opencodeServer: {
            hostname: "127.0.0.1",
            port: expect.any(Number),
          },
        }),
      }),
    );
  });

  it("opens an existing terminal in a new tab when it is detached", async () => {
    const app = express();
    app.use(express.json());
    const createTab = vi.fn(() => ({ tabId: "tab_1", paneId: "pane_1" }));
    const attachPaneContent = vi.fn();
    const broadcastUiCommand = vi.fn();
    const broadcastUiCommandWithReplay = vi.fn();
    app.use(
      "/api",
      createAgentApiRouter({
        layoutStore: {
          createTab,
          attachPaneContent,
          findPaneByTerminalId: () => undefined,
        },
        registry: {
          get: () => ({
            terminalId: "term_1",
            title: "Shell",
            mode: "shell",
            status: "running",
            cwd: "/workspace/project",
          }),
        },
        wsHandler: { broadcastUiCommand, broadcastUiCommandWithReplay },
      }),
    );

    const res = await request(app)
      .post("/api/terminals/term_1/open")
      .send({ name: "Work shell" });

    expect(res.status).toBe(200);
    expect(createTab).toHaveBeenCalledWith({ title: "Work shell" });
    expect(attachPaneContent).toHaveBeenCalledWith(
      "tab_1",
      "pane_1",
      expect.objectContaining({
        kind: "terminal",
        terminalId: "term_1",
        mode: "shell",
      }),
    );
    expect(broadcastUiCommandWithReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "tab.create",
        payload: expect.objectContaining({
          id: "tab_1",
          paneId: "pane_1",
          terminalId: "term_1",
        }),
      }),
    );
    expect(broadcastUiCommand).not.toHaveBeenCalled();
    expect(res.body.data).toMatchObject({
      tabId: "tab_1",
      paneId: "pane_1",
      terminalId: "term_1",
      reused: false,
    });
  });

  it("selects the existing pane when opening an already-attached terminal", async () => {
    const app = express();
    app.use(express.json());
    const selectPane = vi.fn(() => ({ tabId: "tab_1", paneId: "pane_1" }));
    const broadcastUiCommand = vi.fn();
    const broadcastUiCommandWithReplay = vi.fn();
    app.use(
      "/api",
      createAgentApiRouter({
        layoutStore: {
          findPaneByTerminalId: () => ({ tabId: "tab_1", paneId: "pane_1" }),
          selectPane,
        },
        registry: {
          get: () => ({
            terminalId: "term_1",
            title: "Shell",
            mode: "shell",
            status: "running",
          }),
        },
        wsHandler: { broadcastUiCommand, broadcastUiCommandWithReplay },
      }),
    );

    const res = await request(app).post("/api/terminals/term_1/open").send({});

    expect(res.status).toBe(200);
    expect(selectPane).toHaveBeenCalledWith("tab_1", "pane_1");
    expect(broadcastUiCommandWithReplay).toHaveBeenCalledWith({
      command: "tab.select",
      payload: { id: "tab_1" },
    });
    expect(broadcastUiCommandWithReplay).toHaveBeenCalledWith({
      command: "pane.select",
      payload: { tabId: "tab_1", paneId: "pane_1" },
    });
    expect(broadcastUiCommand).not.toHaveBeenCalled();
    expect(res.body.data).toMatchObject({
      tabId: "tab_1",
      paneId: "pane_1",
      terminalId: "term_1",
      reused: true,
    });
  });

  it("rejects blank tab rename payloads", async () => {
    const app = express();
    app.use(express.json());
    const renameTab = vi.fn();
    app.use(
      "/api",
      createAgentApiRouter({
        layoutStore: { renameTab },
        registry: {} as any,
        wsHandler: { broadcastUiCommand: vi.fn() },
      }),
    );

    const res = await request(app)
      .patch("/api/tabs/tab_1")
      .send({ name: "   " });

    expect(res.status).toBe(400);
    expect(renameTab).not.toHaveBeenCalled();
  });

  it("trims tab rename payloads before writing and broadcasts only successful renames", async () => {
    const app = express();
    app.use(express.json());
    const renameTab = vi.fn(() => ({ tabId: "tab_1" }));
    const broadcastUiCommand = vi.fn();
    app.use(
      "/api",
      createAgentApiRouter({
        layoutStore: { renameTab },
        registry: {} as any,
        wsHandler: { broadcastUiCommand },
      }),
    );

    const res = await request(app)
      .patch("/api/tabs/tab_1")
      .send({ name: "  Release prep  " });

    expect(res.status).toBe(200);
    expect(renameTab).toHaveBeenCalledWith("tab_1", "Release prep");
    expect(broadcastUiCommand).toHaveBeenCalledWith({
      command: "tab.rename",
      payload: { id: "tab_1", title: "Release prep" },
    });
  });

  it("does not broadcast tab.rename when the tab does not exist", async () => {
    const app = express();
    app.use(express.json());
    const renameTab = vi.fn(() => ({ message: "tab not found" }));
    const broadcastUiCommand = vi.fn();
    app.use(
      "/api",
      createAgentApiRouter({
        layoutStore: { renameTab },
        registry: {} as any,
        wsHandler: { broadcastUiCommand },
      }),
    );

    const res = await request(app)
      .patch("/api/tabs/missing")
      .send({ name: "Ghost" });

    expect(res.status).toBe(200);
    expect(renameTab).toHaveBeenCalledWith("missing", "Ghost");
    expect(broadcastUiCommand).not.toHaveBeenCalled();
  });
});
