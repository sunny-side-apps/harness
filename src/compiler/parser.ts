import type { PolicyAST, PolicyKind, Condition, ConditionOperator, TimeBound, Schedule } from "@shared/types.ts";
import { ParseError } from "./errors.ts";

// ─── Tokenizer ───────────────────────────────────────────────────────────────

type TokenKind =
  | "keyword"    // allow, deny, noaction, to, on, where, for, during, until, session, requires, approval
  | "string"     // "quoted string"
  | "number"     // 123
  | "ident"      // unquoted identifier
  | "star"       // *
  | "lbracket"   // [
  | "rbracket"   // ]
  | "lbrace"     // {
  | "rbrace"     // }
  | "lparen"     // (
  | "rparen"     // )
  | "comma"      // ,
  | "colon"      // :
  | "dot"        // .
  | "op"         // ==, !=, >=, <=, >, <
  | "eof";

type Token = {
  kind: TokenKind;
  value: string;
  pos: number;
};

const KEYWORDS = new Set([
  "allow", "deny", "noaction", "to", "on", "where", "for", "during",
  "until", "session", "requires", "approval", "weekdays", "weekends",
  "everyday", "contains", "containsAny", "containsAll", "isEmpty",
  "like", "startsWith", "endsWith",
]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i]!)) {
      i++;
      continue;
    }

    const pos = i;

    // Two-char operators
    if (i + 1 < input.length) {
      const two = input.slice(i, i + 2);
      if (two === "==" || two === "!=" || two === ">=" || two === "<=") {
        tokens.push({ kind: "op", value: two, pos });
        i += 2;
        continue;
      }
    }

    // Single-char tokens
    const ch = input[i]!;
    if (ch === "*") { tokens.push({ kind: "star", value: "*", pos }); i++; continue; }
    if (ch === "[") { tokens.push({ kind: "lbracket", value: "[", pos }); i++; continue; }
    if (ch === "]") { tokens.push({ kind: "rbracket", value: "]", pos }); i++; continue; }
    if (ch === "{") { tokens.push({ kind: "lbrace", value: "{", pos }); i++; continue; }
    if (ch === "}") { tokens.push({ kind: "rbrace", value: "}", pos }); i++; continue; }
    if (ch === "(") { tokens.push({ kind: "lparen", value: "(", pos }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen", value: ")", pos }); i++; continue; }
    if (ch === ",") { tokens.push({ kind: "comma", value: ",", pos }); i++; continue; }
    if (ch === ":") { tokens.push({ kind: "colon", value: ":", pos }); i++; continue; }
    if (ch === ".") { tokens.push({ kind: "dot", value: ".", pos }); i++; continue; }
    if (ch === ">" || ch === "<") { tokens.push({ kind: "op", value: ch, pos }); i++; continue; }

    // Quoted string
    if (ch === '"') {
      i++;
      let str = "";
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\") {
          i++;
          if (i < input.length) str += input[i];
        } else {
          str += input[i];
        }
        i++;
      }
      if (i >= input.length) throw new ParseError("Unterminated string literal", pos);
      i++; // closing quote
      tokens.push({ kind: "string", value: str, pos });
      continue;
    }

    // Number
    if (/[0-9]/.test(ch)) {
      let num = "";
      while (i < input.length && /[0-9]/.test(input[i]!)) {
        num += input[i];
        i++;
      }
      tokens.push({ kind: "number", value: num, pos });
      continue;
    }

    // Identifier / keyword
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = "";
      while (i < input.length && /[a-zA-Z0-9_\-/]/.test(input[i]!)) {
        ident += input[i];
        i++;
      }
      const kind: TokenKind = KEYWORDS.has(ident) ? "keyword" : "ident";
      tokens.push({ kind, value: ident, pos });
      continue;
    }

    throw new ParseError(`Unexpected character '${ch}'`, pos);
  }

  tokens.push({ kind: "eof", value: "", pos: i });
  return tokens;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private advance(): Token {
    const tok = this.tokens[this.pos]!;
    this.pos++;
    return tok;
  }

  private expect(kind: TokenKind, value?: string): Token {
    const tok = this.peek();
    if (tok.kind !== kind || (value !== undefined && tok.value !== value)) {
      const expected = value ? `'${value}'` : kind;
      throw new ParseError(
        `Expected ${expected}, got '${tok.value}' (${tok.kind})`,
        tok.pos,
      );
    }
    return this.advance();
  }

  private match(kind: TokenKind, value?: string): Token | null {
    const tok = this.peek();
    if (tok.kind === kind && (value === undefined || tok.value === value)) {
      return this.advance();
    }
    return null;
  }

  parse(): PolicyAST {
    const tok = this.peek();

    let kind: PolicyKind;
    if (tok.value === "allow") {
      kind = "allow";
      this.advance();
    } else if (tok.value === "deny") {
      kind = "deny";
      this.advance();
    } else if (tok.value === "noaction") {
      kind = "noaction";
      this.advance();
      return this.parseNoaction();
    } else {
      throw new ParseError(
        `Expected 'allow', 'deny', or 'noaction', got '${tok.value}'`,
        tok.pos,
      );
    }

    return this.parseAllowOrDeny(kind);
  }

  private parseAgent(): string | "*" {
    if (this.match("star")) return "*";
    const tok = this.peek();
    if (tok.kind === "string") {
      return this.advance().value;
    }
    if (tok.kind === "ident") {
      return this.advance().value;
    }
    throw new ParseError(`Expected agent name (quoted string, identifier, or *), got '${tok.value}'`, tok.pos);
  }

  private parseOperationList(): string[] | ["*"] {
    this.expect("lbracket");
    if (this.match("star")) {
      this.expect("rbracket");
      return ["*"];
    }

    const ops: string[] = [];
    ops.push(this.parseOperationName());
    while (this.match("comma")) {
      ops.push(this.parseOperationName());
    }
    this.expect("rbracket");
    return ops;
  }

  private parseOperationName(): string {
    const tok = this.peek();
    if (tok.kind === "ident" || tok.kind === "keyword") {
      return this.advance().value;
    }
    throw new ParseError(`Expected operation name, got '${tok.value}'`, tok.pos);
  }

  private parseResource(): { service: string; type: string } {
    const service = this.expect("ident").value;
    this.expect("dot");
    const type = this.expect("ident").value;
    return { service, type };
  }

  private parseConditions(): Condition[] {
    this.expect("lbrace");
    const conditions: Condition[] = [];
    conditions.push(this.parseCondition());
    while (this.match("comma")) {
      // Allow trailing comma
      if (this.peek().kind === "rbrace") break;
      conditions.push(this.parseCondition());
    }
    this.expect("rbrace");
    return conditions;
  }

  private parseCondition(): Condition {
    const attribute = this.parseAttributeName();
    const operator = this.parseOperator();
    const value = this.parseConditionValue(operator);
    return { attribute, operator, value };
  }

  private parseAttributeName(): string {
    const tok = this.peek();
    if (tok.kind === "ident" || tok.kind === "keyword") {
      return this.advance().value;
    }
    throw new ParseError(`Expected attribute name, got '${tok.value}'`, tok.pos);
  }

  private parseOperator(): ConditionOperator {
    const tok = this.peek();

    // Two-char operators from op token
    if (tok.kind === "op") {
      this.advance();
      return tok.value as ConditionOperator;
    }

    // Named operators (keywords)
    if (tok.kind === "keyword") {
      const name = tok.value;
      if (name === "contains" || name === "containsAny" || name === "containsAll" ||
          name === "isEmpty" || name === "like" || name === "startsWith" || name === "endsWith") {
        this.advance();
        return name as ConditionOperator;
      }
    }

    throw new ParseError(`Expected operator, got '${tok.value}'`, tok.pos);
  }

  private parseConditionValue(operator: ConditionOperator): string | string[] | number | boolean {
    // isEmpty takes no value
    if (operator === "isEmpty") return true;

    const tok = this.peek();

    // String value
    if (tok.kind === "string") {
      return this.advance().value;
    }

    // Number value
    if (tok.kind === "number") {
      return Number(this.advance().value);
    }

    // Boolean
    if (tok.kind === "ident" && (tok.value === "true" || tok.value === "false")) {
      return this.advance().value === "true";
    }

    // Array value: ["a", "b"]
    if (tok.kind === "lbracket") {
      return this.parseStringArray();
    }

    throw new ParseError(`Expected value (string, number, boolean, or array), got '${tok.value}'`, tok.pos);
  }

  private parseStringArray(): string[] {
    this.expect("lbracket");
    const values: string[] = [];
    if (this.peek().kind !== "rbracket") {
      values.push(this.expect("string").value);
      while (this.match("comma")) {
        if (this.peek().kind === "rbracket") break;
        values.push(this.expect("string").value);
      }
    }
    this.expect("rbracket");
    return values;
  }

  private parseTimeBound(): TimeBound {
    const tok = this.peek();

    // for <duration> | for session
    if (tok.kind === "keyword" && tok.value === "for") {
      this.advance();
      // "for session"
      if (this.peek().kind === "keyword" && this.peek().value === "session") {
        this.advance();
        return { kind: "session" };
      }
      // "for 2h" / "for 30m" / "for 1d"
      return { kind: "duration", seconds: this.parseDuration() };
    }

    // during <schedule>
    if (tok.kind === "keyword" && tok.value === "during") {
      this.advance();
      return { kind: "schedule", schedule: this.parseSchedule() };
    }

    // until <timestamp>
    if (tok.kind === "keyword" && tok.value === "until") {
      this.advance();
      const timestamp = this.expect("string").value;
      return { kind: "until", timestamp };
    }

    throw new ParseError(`Expected time bound (for, during, until), got '${tok.value}'`, tok.pos);
  }

  private parseDuration(): number {
    const tok = this.peek();
    let raw: string;

    if (tok.kind === "number") {
      raw = this.advance().value;
      // Next should be a unit suffix as ident
      const unit = this.peek();
      if (unit.kind === "ident") {
        raw += this.advance().value;
      } else {
        throw new ParseError(`Expected duration unit (h, m, d) after number`, unit.pos);
      }
    } else if (tok.kind === "ident") {
      raw = this.advance().value;
    } else {
      throw new ParseError(`Expected duration (e.g. 2h, 30m, 1d), got '${tok.value}'`, tok.pos);
    }

    return parseDurationString(raw, tok.pos);
  }

  private parseSchedule(): Schedule {
    const tok = this.peek();
    if (tok.kind !== "keyword" || !["weekdays", "weekends", "everyday"].includes(tok.value)) {
      throw new ParseError(
        `Expected schedule (weekdays, weekends, everyday), got '${tok.value}'`,
        tok.pos,
      );
    }
    const days = this.advance().value as Schedule["days"];

    // Optional (startHour, endHour)
    if (this.match("lparen")) {
      const startTok = this.expect("number");
      const startHour = Number(startTok.value);
      this.expect("comma");
      const endTok = this.expect("number");
      const endHour = Number(endTok.value);
      this.expect("rparen");

      if (startHour < 0 || startHour > 23) throw new ParseError(`Start hour must be 0-23, got ${startHour}`, startTok.pos);
      if (endHour < 0 || endHour > 23) throw new ParseError(`End hour must be 0-23, got ${endHour}`, endTok.pos);

      return { days, startHour, endHour };
    }

    // Default: full day
    return { days, startHour: 0, endHour: 24 };
  }

  private parseRequiresApproval(): { operations: string[] } {
    this.expect("keyword", "requires");
    this.expect("keyword", "approval");

    // Optional: "for [operations]"
    if (this.match("keyword", "for")) {
      const ops = this.parseOperationList();
      return { operations: ops as string[] };
    }

    // No specific operations — approval required for all
    return { operations: ["*"] };
  }

  private parseAllowOrDeny(kind: PolicyKind): PolicyAST {
    const agent = this.parseAgent();
    this.expect("keyword", "to");
    const operations = this.parseOperationList();
    this.expect("keyword", "on");
    const resource = this.parseResource();

    let conditions: Condition[] | undefined;
    let timeBound: TimeBound | undefined;
    let requiresApproval: { operations: string[] } | undefined;

    // Parse optional clauses in any order
    while (this.peek().kind !== "eof") {
      const next = this.peek();

      if (next.kind === "keyword" && next.value === "where") {
        if (conditions) throw new ParseError("Duplicate 'where' clause", next.pos);
        this.advance();
        conditions = this.parseConditions();
        continue;
      }

      if (next.kind === "keyword" && (next.value === "for" || next.value === "during" || next.value === "until")) {
        if (timeBound) throw new ParseError("Duplicate time bound", next.pos);
        timeBound = this.parseTimeBound();
        continue;
      }

      if (next.kind === "keyword" && next.value === "requires") {
        if (kind === "deny") throw new ParseError("'requires approval' is not allowed on deny rules", next.pos);
        if (requiresApproval) throw new ParseError("Duplicate 'requires approval'", next.pos);
        requiresApproval = this.parseRequiresApproval();
        continue;
      }

      throw new ParseError(`Unexpected token '${next.value}'`, next.pos);
    }

    return {
      kind,
      agent,
      operations,
      resource,
      ...(conditions && { conditions }),
      ...(timeBound && { timeBound }),
      ...(requiresApproval && { requiresApproval }),
    };
  }

  private parseNoaction(): PolicyAST {
    const agent = this.parseAgent();
    this.expect("keyword", "on");
    const resource = this.parseResource();

    let timeBound: TimeBound | undefined;

    // Optional time bound
    if (this.peek().kind !== "eof") {
      const next = this.peek();
      if (next.kind === "keyword" && (next.value === "for" || next.value === "during" || next.value === "until")) {
        timeBound = this.parseTimeBound();
      } else {
        throw new ParseError(`Unexpected token '${next.value}' in noaction rule`, next.pos);
      }
    }

    // Check nothing extra
    if (this.peek().kind !== "eof") {
      const extra = this.peek();
      throw new ParseError(`Unexpected token '${extra.value}' after noaction rule`, extra.pos);
    }

    return {
      kind: "noaction",
      agent,
      operations: ["*"],
      resource,
      ...(timeBound && { timeBound }),
    };
  }
}

// ─── Duration Parser ─────────────────────────────────────────────────────────

function parseDurationString(raw: string, pos: number): number {
  const match = raw.match(/^(\d+)(h|m|d|s)$/);
  if (!match) throw new ParseError(`Invalid duration '${raw}'. Expected format: <number><unit> where unit is h, m, d, or s`, pos);

  const amount = Number(match[1]);
  const unit = match[2] as string;

  switch (unit) {
    case "s": return amount;
    case "m": return amount * 60;
    case "h": return amount * 3600;
    case "d": return amount * 86400;
    default: throw new ParseError(`Unknown duration unit '${unit}'`, pos);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function parse(input: string): PolicyAST {
  const trimmed = input.trim();
  if (!trimmed) throw new ParseError("Empty policy input");

  const tokens = tokenize(trimmed);
  const parser = new Parser(tokens);
  const ast = parser.parse();
  return ast;
}
