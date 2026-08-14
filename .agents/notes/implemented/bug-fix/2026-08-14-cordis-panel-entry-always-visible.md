# Agent Note: Cordis panel entry stays visible with an empty inventory

Status: implemented

English | [中文](2026-08-14-cordis-panel-entry-always-visible.zh.md)

## Problem

The Cordis dynamic-plugin registry is process memory only, so a fresh page or a server restart starts with no definitions. The frame-wide panel rendered nothing at all — the sidebar-footer badge included — whenever the inventory was empty (`if (all.length === 0) return null` in `CordisPanel`), so a desktop-app restart removed the only entry point to the plugin inventory the user had already used, with nothing on screen saying why.

## Decision

`CordisPanel` keeps the footer badge mounted with an empty inventory. The panel body already separates the loading, read-error, and genuinely-empty states, so opening it before the first read shows the loading line and after it shows the empty note. The badge is now a stable frame-wide entry point across pages and server restarts; definitions themselves remain ephemeral and unchanged.

## Alternatives considered

**Persist definitions across restarts.** Rejected: it contradicts the host-runner contract that the registry is process memory and nothing is written to disk, and it is a far larger change than the reported gap needs.

**Hide the badge until the first read settles.** Rejected: the panel already re-reads on mount and on open, so a short invisible window buys nothing.

## Consequences

The sidebar footer always carries the plugin entry, including on a fresh server with no definitions; opening it shows the empty note. The host runner and its durability contract are untouched, and the panel keeps its existing loading and error copy for the moments before a read settles.
