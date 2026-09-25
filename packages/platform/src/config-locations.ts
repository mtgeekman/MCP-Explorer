// Where other MCP clients keep their server configs (phase 05, slice 4).
// Per-OS paths are platform knowledge, so they live here (CLAUDE.md: no
// platform-specific API outside the platform abstraction layer). This module
// only names paths; whether each exists is checked by the caller, and only
// after the user asks to import (plan decision 1).
//
// Locations researched 2026-09-25 and recorded on the plan page. Two are
// unverified against a primary source and say so: Claude Desktop on Linux,
// which has no official build, and VS Code's user mcp.json outside Windows.
// macOS is not built (D11) but is listed, so nothing here forecloses it.
import { posix, win32 } from 'node:path';

export type ConfigClient = 'claude-desktop' | 'claude-code' | 'vscode' | 'cursor';
/** Mirrors the backend's ConfigFormat: where in the file its servers sit. */
export type ConfigLayout = 'mcpServers' | 'claude-code-user' | 'vscode' | 'vscode-settings' | 'devcontainer';
export type ConfigScope = 'user' | 'project' | 'managed';

export interface ConfigLocation {
  client: ConfigClient;
  layout: ConfigLayout;
  scope: ConfigScope;
  path: string;
  /** For a project file, the folder it belongs to. */
  projectRoot?: string;
  /** What the user is told this file is. */
  label: string;
}

export interface LocationContext {
  platform: NodeJS.Platform;
  home: string;
  /** The process environment; only the variables that locate config folders are read. */
  env: Record<string, string | undefined>;
}

/** Every user-level and managed config file the four clients may keep on this platform. */
export function userConfigLocations(ctx: LocationContext): ConfigLocation[] {
  const p = ctx.platform === 'win32' ? win32 : posix;
  const home = ctx.home;
  const out: ConfigLocation[] = [];
  const add = (client: ConfigClient, layout: ConfigLayout, scope: ConfigScope, path: string, label: string) =>
    out.push({ client, layout, scope, path, label });

  if (ctx.platform === 'win32') {
    const appData = ctx.env.APPDATA ?? p.join(home, 'AppData', 'Roaming');
    const localAppData = ctx.env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local');
    const programFiles = ctx.env.ProgramFiles ?? 'C:\\Program Files';
    add('claude-desktop', 'mcpServers', 'user', p.join(appData, 'Claude', 'claude_desktop_config.json'), 'Claude Desktop');
    // The Microsoft Store install redirects AppData into its package folder.
    add('claude-desktop', 'mcpServers', 'user', p.join(localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'), 'Claude Desktop (Microsoft Store)');
    add('claude-code', 'claude-code-user', 'user', p.join(home, '.claude.json'), 'Claude Code, user and local scopes');
    add('claude-code', 'mcpServers', 'managed', p.join(programFiles, 'ClaudeCode', 'managed-mcp.json'), 'Claude Code, managed');
    add('vscode', 'vscode', 'user', p.join(appData, 'Code', 'User', 'mcp.json'), 'VS Code, user');
    add('vscode', 'vscode-settings', 'user', p.join(appData, 'Code', 'User', 'settings.json'), 'VS Code, user settings (before 1.102)');
  } else if (ctx.platform === 'darwin') {
    const support = p.join(home, 'Library', 'Application Support');
    add('claude-desktop', 'mcpServers', 'user', p.join(support, 'Claude', 'claude_desktop_config.json'), 'Claude Desktop');
    add('claude-code', 'claude-code-user', 'user', p.join(home, '.claude.json'), 'Claude Code, user and local scopes');
    add('claude-code', 'mcpServers', 'managed', '/Library/Application Support/ClaudeCode/managed-mcp.json', 'Claude Code, managed');
    add('vscode', 'vscode', 'user', p.join(support, 'Code', 'User', 'mcp.json'), 'VS Code, user');
    add('vscode', 'vscode-settings', 'user', p.join(support, 'Code', 'User', 'settings.json'), 'VS Code, user settings (before 1.102)');
  } else {
    const config = ctx.env.XDG_CONFIG_HOME || p.join(home, '.config');
    add('claude-desktop', 'mcpServers', 'user', p.join(config, 'Claude', 'claude_desktop_config.json'), 'Claude Desktop (unofficial Linux builds)');
    add('claude-code', 'claude-code-user', 'user', p.join(home, '.claude.json'), 'Claude Code, user and local scopes');
    add('claude-code', 'mcpServers', 'managed', '/etc/claude-code/managed-mcp.json', 'Claude Code, managed');
    add('vscode', 'vscode', 'user', p.join(config, 'Code', 'User', 'mcp.json'), 'VS Code, user');
    add('vscode', 'vscode-settings', 'user', p.join(config, 'Code', 'User', 'settings.json'), 'VS Code, user settings (before 1.102)');
  }
  add('vscode', 'mcpServers', 'user', p.join(home, '.copilot', 'mcp-config.json'), 'VS Code, portable user file');
  add('cursor', 'mcpServers', 'user', p.join(home, '.cursor', 'mcp.json'), 'Cursor, global');
  return out;
}

/** The config files a project folder may hold, for a folder the user chose. */
export function projectConfigLocations(root: string, platform: NodeJS.Platform): ConfigLocation[] {
  const p = platform === 'win32' ? win32 : posix;
  const at = (...parts: string[]) => p.join(root, ...parts);
  return [
    // Claude Code's project file; VS Code's portable format uses the same name and layout.
    { client: 'claude-code', layout: 'mcpServers', scope: 'project', path: at('.mcp.json'), projectRoot: root, label: 'Claude Code (and VS Code), project' },
    { client: 'vscode', layout: 'vscode', scope: 'project', path: at('.vscode', 'mcp.json'), projectRoot: root, label: 'VS Code, workspace' },
    { client: 'vscode', layout: 'devcontainer', scope: 'project', path: at('.devcontainer', 'devcontainer.json'), projectRoot: root, label: 'VS Code, dev container' },
    { client: 'vscode', layout: 'devcontainer', scope: 'project', path: at('.devcontainer.json'), projectRoot: root, label: 'VS Code, dev container' },
    { client: 'cursor', layout: 'mcpServers', scope: 'project', path: at('.cursor', 'mcp.json'), projectRoot: root, label: 'Cursor, project' },
  ];
}
