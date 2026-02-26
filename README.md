
## Overview

**Save My Ass** is a secure proxy and policy enforcement layer that allows users to grant AI agents controlled, auditable, and selective access to their email and other services.

It starts where OAuth stops. It acts as an invisible access control plane between AI agents and service providers (Gmail initially, expanding to Slack, GitHub, Google Calendar, Google Drive, Stripe), enforcing user-defined policies, delegation chains, cross-service flow rules, and just-in-time approvals.

Save My Ass ensures that AI agents can only see and act on resources they are explicitly allowed to access - and only for as long as they are allowed.

---

## Vision

Enable safe, autonomous AI agents by providing a secure abstraction layer over sensitive systems, starting with email.

Long-term, Save My Ass expands into a universal access control layer for AI agents across:

- Email (initial focus)
- Cloud storage (Google Drive, Dropbox)
- Messaging (Slack, Teams)
- Documents (Notion, Confluence)
- Source code (GitHub, GitLab)
- Payments (Stripe)

---

## Problem

AI agents that access email and other APIs get full account access. There is no way to scope what they can see or do, or for how long. Specifically:

- **OAuth scopes are too coarse.** `gmail.modify` grants access to everything — read, send, delete, forward, modify filters, change vacation settings. There is no way to say "read-only, only from my team, for 2 hours."
- **Agents are not to be trusted yet.** Today, AI agents often operate as opaque black boxes—users and administrators have little visibility into what data they access, how they reason, or which actions they will take. 
- **No time boundaries.** Agents hold standing access indefinitely. There is no built-in way to grant "read access for 2 hours" or "only during business hours."
- **No cross-service isolation.** An agent that reads medical emails can immediately post that content to Slack. There is no data flow control across API boundaries.
- **Agents exceed user permissions.** An agent delegated by Alice should never have more access than Alice. With multi-agent orchestration (agent A spawns agent B), permissions should narrow at each hop.

---

## Core Goals

### Primary goals (MVP)

- Allow AI agents to safely read and search user email
- Enforce fine-grained access policies that go beyond OAuth scopes
- Prevent agents from seeing unauthorized emails
- Operate statelessly without syncing or storing emails internally
- Support timeboxed access that automatically expires
- Enable safe agent actions via draft-first and approval workflows
- Provide full auditability and transparency

### Trust and safety goals

- Default-deny: if no policy matches, the action is blocked
- Draft-first model for outgoing email
- Just-in-time approval for sensitive actions
- Live audit feed of agent activity
- No internal storage of email bodies (Gmail remains source of truth)

### Coming soon

- Cross-service flow isolation: when an agent reads sensitive data from one service, block it from posting to another (e.g. medical emails → Slack)

### User focus

Initial target users:

- Founders
- Executives
- Individual professionals using AI assistants

Expansion target:

- Small teams
- AI-native companies

---

## Business Model

Pricing model:

- Usage based, per number of actions
- Generous free tier.

---

## Brand

Product name:

Save My Ass

Positioning:

Secure email access layer for AI agents.

Core value proposition:

Control what AI agents can see and do in your inbox.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture & Implementation](docs/ARCHITECTURE.md) | System architecture, compiler pipeline, runtime engine, policy storage, project structure, CLI, and MVP scope |
| [Permission Language (DSL)](docs/DSL.md) | AgentGate DSL syntax, policy engine model, delegation chains, and cross-service flow rules |
| [Classification & Integrations](docs/CLASSIFICATION.md) | Email provider integration, classification system, and multi-account/multi-service support |
| [Security & Trust](docs/SECURITY.md) | Security model, risk tiers, draft-first safety, approval system, timeboxed access, audit, and agent interface |
