---
name: impeccable
description: "Use when the user wants to design, redesign, shape, critique, audit, polish, simplify, harden, animate, or otherwise improve a frontend interface: websites, landing pages, dashboards, product UI, components, forms, settings, onboarding, empty states, and native iOS or Android screens. Handles UX review, hierarchy, layout, typography, color, motion, UX copy, accessibility, responsive behavior, edge cases, and capturing or documenting design systems (DESIGN.md, tokens). Also for making bland UI bolder, loud UI quieter, or ambitious visual effects. Not for backend-only or non-UI tasks."
user-invocable: true
argument-hint: "[command] [target]"
---

# Impeccable

This is the project discovery adapter for the canonical skill at `.github/skills/impeccable/`. Resolve that path from the repository root, not from this adapter's directory.

1. Read `.github/skills/impeccable/SKILL.md` before handling the request. Follow its setup, command routing, and selected playbook with the user's original request and arguments.
2. Treat `.github/skills/impeccable/` as the canonical `<skill-base-dir>`. Resolve its relative reference links and script paths from that directory, and keep the working directory at the repository root when invoking its launcher. Use `.github/skills/impeccable/scripts/impeccable` under Git Bash/sh, or `.github/skills/impeccable/scripts/impeccable.cmd` on a Windows shell without sh.
3. With no arguments, follow the canonical `reference/routing.md` menu rather than choosing a command automatically.

Keep implementation instructions, references, and scripts in the canonical directory. If its trigger description changes, synchronize this adapter's description.
