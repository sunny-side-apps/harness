 
## Overview

**Mailcloak.ai** is a secure proxy and policy enforcement layer that allows users to grant AI agents controlled, auditable, and selective access to their email.

It acts as an invisible access control plane between AI agents and email providers (Gmail initially), enforcing user-defined policies, classification rules, and just-in-time approvals.

Mailcloak ensures that AI agents can only see and act on emails they are explicitly allowed to access.

---

## Vision

Enable safe, autonomous AI agents by providing a secure abstraction layer over sensitive systems, starting with email.

Long-term, Mailcloak can expand into a universal access control layer for AI agents across:

- Email (initial focus)
- Cloud storage (Google Drive, Dropbox)
- Messaging (Slack, Teams)
- Documents (Notion, Confluence)
- Source code (GitHub, GitLab)

---

## Core Goals

### Primary goals (MVP)

- Allow AI agents to safely read and search user email
- Enforce fine-grained access policies
- Prevent agents from seeing unauthorized emails
- Provide full auditability and transparency
- Enable safe agent actions via draft-first and approval workflows
- Operate statelessly without syncing or storing emails internally

### Trust and safety goals

- Default read-only access
- Draft-first model for outgoing email
- Just-in-time approval for sensitive actions
- Live audit feed of agent activity
- No internal storage of email bodies (Gmail remains source of truth)

### User focus

Initial target users:

- Founders
- Executives
- Individual professionals using AI assistants

Expansion target:

- Small teams
- AI-native companies

---

## Key Architectural Decisions

### Email provider integration

Initial provider:

- Gmail via OAuth and Gmail API

Future providers:

- IMAP
- Microsoft Outlook

Gmail remains the source of truth.

Mailcloak does not replicate or store full inbox contents.

---

### Stateless proxy architecture

Mailcloak operates as a stateless enforcement proxy.

It:

- Queries Gmail on demand
- Classifies emails on the fly if needed
- Writes classification results back to Gmail as labels
- Filters responses before returning them to agents

Mailcloak does not maintain a full inbox copy.

Caching is used only for performance.

---

### Policy enforcement engine

Policy model and engine:

- Cedar policy engine (https://www.cedarpolicy.com)

Policies are:

- Defined in natural language by users
- Compiled into Cedar policies
- Deterministically enforced at runtime

Example policy intent:

> Allow my accounting agent to read invoice emails but require approval before archiving them.

Policies operate on:

- Agent identity
- Email classification labels
- Sender domain
- Requested action

---

### Classification system

Classification model:

Hybrid approach:

- Deterministic rules (sender domains, patterns)
- LLM-based classification

Classification results are stored as Gmail labels.

Example labels:

```
safeinbox/classification/invoice  
safeinbox/classification/travel  
safeinbox/classification/personal  
safeinbox/classification/financial
```


Gmail serves as the classification storage layer.

Mailcloak does not store classification internally.

---

### Draft-first safety model

Outgoing email safety model:

Default behavior:

- Agent requests to send email
- Mailcloak creates a Gmail draft instead of sending immediately
- Draft is labeled as pending approval

Optional approval paths:

- User approval via chat app
- Delayed automatic send after configurable time window
- Dead zones prevent sending during sleep hours

Users can always see and edit drafts directly in Gmail.

This dramatically reduces risk and increases trust.

---

### Just-in-time approval system

Sensitive actions can require approval.

Approval is delivered via chat platforms:

Initial integrations:

- Slack
- Telegram

Future integrations:

- WhatsApp
- Discord
- Viber

Approval grants a temporary execution token valid for a single operation.

---

### Agent interface model

Primary interface:

Gmail API proxy

Agents interact using:

- Gmail API compatible interface
- IMAP proxy (future)

Optional interface:

- MCP server adapter

MCP is secondary and provided for users who prefer MCP-native agents.

---

### Virtual inbox abstraction

Externally, each agent experiences a filtered virtual inbox.

Internally, Mailcloak performs stateless filtering.

Agents never see unauthorized emails.

Unauthorized emails are completely invisible.

---

### Audit and transparency system

Mailcloak maintains a complete audit log of all agent actions.

Includes:

- Email reads
- Searches
- Draft creation
- Archive requests
- Approval events
- Policy decisions

Users can view a live activity feed.

This builds trust and accountability.

---

## Core System Architecture

```
Agent  
│  
├── Gmail API client  
├── IMAP client (future)  
└── MCP client (optional)  
│  
▼  
Mailcloak Proxy Layer  
│  
├── Policy Enforcement Layer (Cedar)  
├── Classification Engine (LLM + rules)  
├── Approval Broker  
├── Audit Log  
│  
▼  
Gmail API (source of truth)
```


---

## Major Functional Components

### Access proxy

Responsibilities:

- Intercepts all agent requests
- Filters unauthorized emails
- Enforces policies
- Controls write operations

---

### Classification engine

Responsibilities:

- Classifies emails using hybrid model
- Writes classification labels to Gmail

---

### Policy engine

Responsibilities:

- Evaluates Cedar policies
- Determines allow / deny / require approval

---

### Approval broker

Responsibilities:

- Sends approval requests via chat apps
- Issues temporary execution tokens

---

### Audit system

Responsibilities:

- Records all actions
- Provides live feed and history

---

### MCP adapter

Responsibilities:

- Exposes Mailcloak functionality via MCP protocol

Optional convenience layer.

---

## Security Model

Key principles:

- Zero internal email storage
- Gmail remains source of truth
- Policy enforced on every access
- Draft-first sending model
- Explicit approval for sensitive actions
- Complete audit trail

---

## MVP Scope

Included:

- Gmail OAuth integration
- Gmail API proxy (search, read, archive)
- Classification and Gmail labels
- Cedar policy engine
- Draft creation (no auto-send initially)
- Audit logging
- Slack or Telegram approval integration

Excluded initially:

- Outlook support
- IMAP proxy
- Automatic send without approval
- Multi-service integrations

---

## Business Model

Pricing model:

- Per connected inbox per month
- Includes email usage quota
- Additional usage billed as overage

Target positioning:

Serious SaaS product with potential expansion into platform infrastructure.

---

## Brand

Product name:

Mailcloak.ai

Positioning:

Secure email access layer for AI agents.

Core value proposition:

Control what AI agents can see and do in your inbox.

---

## Long-Term Expansion

Mailcloak can expand beyond email into:

- Google Drive access control
- Slack access control
- Notion access control
- GitHub access control

Becoming a universal access control layer for autonomous agents.

---

## Summary

Mailcloak.ai provides a secure, policy-driven, stateless proxy layer that enables safe AI agent access to email.

It enforces fine-grained permissions, protects sensitive information, enables safe automation, and builds user trust through transparency and control.

It serves as foundational infrastructure for the future of autonomous AI systems.