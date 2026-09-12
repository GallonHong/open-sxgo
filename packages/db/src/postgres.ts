import { Pool } from 'pg';
import type { Database, Query } from './adapter';

/**
 * The application deliberately keeps one SQL dialect at its boundary.  The
 * local and D1 adapters consume SQLite SQL, while the PostgreSQL adapter
 * translates that small, documented subset at the boundary.  Keeping the
 * translator here means callers do not have to interpolate values or maintain
 * a second copy of every business query.
 */

type QueryResultLike = {
  rows?: unknown[];
  rowCount?: number | null;
  command?: string;
};

type QueryResponse = QueryResultLike | QueryResultLike[];

type QueryConfigLike = {
  text: string;
  values?: unknown[];
};

/** A narrow structural type makes the adapter straightforward to fake in tests. */
export type PostgresQueryable = {
  query(config: QueryConfigLike): Promise<QueryResponse>;
};

type PostgresPoolLike = PostgresQueryable & {
  connect(): Promise<PostgresQueryable & { release(): void }>;
};

type SqlTokenKind = 'word' | 'number' | 'string' | 'quoted' | 'punctuation';

type SqlToken = {
  kind: SqlTokenKind;
  text: string;
  start: number;
  end: number;
  /** Parenthesis depth before this token. */
  depth: number;
};

type FunctionCall = {
  token: SqlToken;
  open: SqlToken;
  close: SqlToken;
  openIndex: number;
  closeIndex: number;
};

type TextEdit = { start: number; end: number; text: string };

function isWordStart(char: string | undefined) {
  return !!char && /[A-Za-z_$]/.test(char);
}

function isWordPart(char: string | undefined) {
  return !!char && /[A-Za-z0-9_$]/.test(char);
}

function isNumberStart(char: string | undefined, next: string | undefined) {
  return !!char && /[0-9]/.test(char) && (next === undefined || !/[A-Za-z_$]/.test(next));
}

function dollarQuoteAt(sql: string, offset: number) {
  const match = sql.slice(offset).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
  return match?.[0];
}

/**
 * Tokenize SQL without interpreting strings, quoted identifiers or comments.
 * It is intentionally small: the adapter only needs token boundaries for the
 * compatibility rewrites below, and does not try to validate SQL grammar.
 */
function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  let depth = 0;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      let commentDepth = 1;
      while (i < sql.length && commentDepth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          commentDepth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          commentDepth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }

    if (char === "'") {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '\\' && i + 1 < sql.length) {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ kind: 'string', text: sql.slice(start, i), start, end: i, depth });
      continue;
    }

    if (char === '"' || char === '`') {
      const quote = char;
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ kind: 'quoted', text: sql.slice(start, i), start, end: i, depth });
      continue;
    }

    if (char === '[') {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === ']') {
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ kind: 'quoted', text: sql.slice(start, i), start, end: i, depth });
      continue;
    }

    const dollarTag = char === '$' ? dollarQuoteAt(sql, i) : undefined;
    if (dollarTag) {
      const start = i;
      const close = sql.indexOf(dollarTag, i + dollarTag.length);
      i = close < 0 ? sql.length : close + dollarTag.length;
      tokens.push({ kind: 'string', text: sql.slice(start, i), start, end: i, depth });
      continue;
    }

    if (isWordStart(char)) {
      const start = i;
      i += 1;
      while (i < sql.length && isWordPart(sql[i])) i += 1;
      tokens.push({ kind: 'word', text: sql.slice(start, i), start, end: i, depth });
      continue;
    }

    if (isNumberStart(char, next)) {
      const start = i;
      i += 1;
      while (i < sql.length && /[0-9.eE_+-]/.test(sql[i])) {
        // A sign is part of an exponent only.  Leaving the rest as punctuation
        // is sufficient for the rewrites and avoids swallowing `1+2`.
        const previous = sql[i - 1];
        if ((sql[i] === '+' || sql[i] === '-') && previous !== 'e' && previous !== 'E') break;
        i += 1;
      }
      tokens.push({ kind: 'number', text: sql.slice(start, i), start, end: i, depth });
      continue;
    }

    const start = i;
    i += 1;
    tokens.push({ kind: 'punctuation', text: char, start, end: i, depth });
    if (char === '(') depth += 1;
    else if (char === ')' && depth > 0) depth -= 1;
  }

  return tokens;
}

function tokenIs(token: SqlToken | undefined, value: string) {
  return token?.kind === 'word' && token.text.toUpperCase() === value;
}

function punctuationIs(token: SqlToken | undefined, value: string) {
  return token?.kind === 'punctuation' && token.text === value;
}

function trimRange(sql: string, start: number, end: number) {
  while (start < end && /\s/.test(sql[start])) start += 1;
  while (end > start && /\s/.test(sql[end - 1])) end -= 1;
  return { start, end };
}

function functionArgs(sql: string, call: FunctionCall): string[] | null {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = call.open.end;
  for (let i = call.openIndex + 1; i < call.closeIndex; i += 1) {
    const token = tokenizeTokenAtIndex(call, i);
    if (token && punctuationIs(token, ',') && token.depth === call.open.depth + 1) {
      ranges.push(trimRange(sql, start, token.start));
      start = token.end;
    }
  }
  const tail = trimRange(sql, start, call.close.start);
  if (tail.start !== tail.end || ranges.length > 0) ranges.push(tail);
  return ranges.map((range) => sql.slice(range.start, range.end));
}

/** `FunctionCall` keeps no token array to make rewrites cheap to pass around. */
const tokenLists = new WeakMap<FunctionCall, SqlToken[]>();

function tokenizeTokenAtIndex(call: FunctionCall, index: number) {
  return tokenLists.get(call)?.[index];
}

function collectFunctionCalls(sql: string, names: ReadonlySet<string>) {
  const tokens = tokenizeSql(sql);
  const calls: FunctionCall[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== 'word' || !names.has(token.text.toLowerCase())) continue;
    const open = tokens[i + 1];
    if (!punctuationIs(open, '(')) continue;
    let closeIndex = -1;
    for (let j = i + 2; j < tokens.length; j += 1) {
      // Opening parentheses carry the depth before incrementing it; closing
      // parentheses carry the depth before decrementing it.  Their matching
      // pair is therefore `open.depth + 1`.
      if (punctuationIs(tokens[j], ')') && tokens[j].depth === open.depth + 1) {
        closeIndex = j;
        break;
      }
    }
    if (closeIndex < 0) continue;
    const call: FunctionCall = {
      token,
      open,
      close: tokens[closeIndex],
      openIndex: i + 1,
      closeIndex,
    };
    tokenLists.set(call, tokens);
    calls.push(call);
  }
  return calls;
}

function applyEdits(sql: string, edits: TextEdit[]) {
  if (!edits.length) return sql;
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let output = sql;
  for (const edit of ordered)
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return output;
}

function decodeSqlString(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) return undefined;
  return trimmed.slice(1, -1).replaceAll("''", "'");
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function rewriteQuestionPlaceholders(sql: string) {
  const tokens = tokenizeSql(sql);
  const numbered = tokens.some(
    (token) => token.kind === 'punctuation' && /^\$[0-9]+$/.test(token.text),
  );

  // `$1` is tokenized as `$` + `1` by the small tokenizer.  Detect it from
  // source spans so mixed SQLite/PostgreSQL placeholders fail explicitly.
  const hasNumbered =
    /\$[1-9][0-9]*/.test(
      tokens
        .filter((token) => token.kind !== 'string' && token.kind !== 'quoted')
        .map((token) => token.text)
        .join(' '),
    ) || numbered;
  const edits: TextEdit[] = [];
  let questionCount = 0;

  let i = 0;
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'bracket' | 'line' | 'block' | 'dollar' =
    'normal';
  let blockDepth = 0;
  let dollarTag = '';
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (state === 'normal') {
      if (char === '-' && next === '-') {
        state = 'line';
        i += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block';
        blockDepth = 1;
        i += 2;
        continue;
      }
      if (char === "'") {
        state = 'single';
        i += 1;
        continue;
      }
      if (char === '"') {
        state = 'double';
        i += 1;
        continue;
      }
      if (char === '`') {
        state = 'backtick';
        i += 1;
        continue;
      }
      if (char === '[') {
        state = 'bracket';
        i += 1;
        continue;
      }
      const tag = char === '$' ? dollarQuoteAt(sql, i) : undefined;
      if (tag) {
        state = 'dollar';
        dollarTag = tag;
        i += tag.length;
        continue;
      }
      if (char === '?' && next !== '|' && next !== '&') {
        if (hasNumbered)
          throw new Error('POSTGRES_SQL_MIXED_PLACEHOLDERS: use either ? or $n placeholders');
        questionCount += 1;
        edits.push({ start: i, end: i + 1, text: `$${questionCount}` });
      }
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (char === '\n') state = 'normal';
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (char === '/' && next === '*') {
        blockDepth += 1;
        i += 2;
      } else if (char === '*' && next === '/') {
        blockDepth -= 1;
        i += 2;
        if (blockDepth === 0) state = 'normal';
      } else i += 1;
      continue;
    }
    if (state === 'dollar') {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length;
        state = 'normal';
      } else i += 1;
      continue;
    }
    if (state === 'bracket') {
      if (char === ']') state = 'normal';
      i += 1;
      continue;
    }
    if (char === '\\' && state === 'single' && i + 1 < sql.length) {
      i += 2;
      continue;
    }
    if (
      (state === 'single' && char === "'") ||
      (state === 'double' && char === '"') ||
      (state === 'backtick' && char === '`')
    ) {
      if (sql[i + 1] === char) i += 2;
      else {
        state = 'normal';
        i += 1;
      }
    } else i += 1;
  }
  return applyEdits(sql, edits);
}

function rewriteInsertOrIgnore(sql: string) {
  const tokens = tokenizeSql(sql);
  let insertIndex = -1;
  let ignoreEnd = -1;
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (
      tokenIs(tokens[i], 'INSERT') &&
      tokenIs(tokens[i + 1], 'OR') &&
      tokenIs(tokens[i + 2], 'IGNORE') &&
      tokens[i].depth === tokens[i + 1].depth &&
      tokens[i].depth === tokens[i + 2].depth
    ) {
      insertIndex = i;
      ignoreEnd = tokens[i + 2].end;
      break;
    }
  }
  if (insertIndex < 0) return sql;

  const edits: TextEdit[] = [{ start: tokens[insertIndex + 1].start, end: ignoreEnd, text: '' }];
  const statementDepth = tokens[insertIndex].depth;
  let hasConflictClause = false;
  let returningIndex = -1;
  let terminatorIndex = -1;
  for (let i = insertIndex + 3; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.depth !== statementDepth) continue;
    if (tokenIs(token, 'ON') && tokenIs(tokens[i + 1], 'CONFLICT')) hasConflictClause = true;
    if (returningIndex < 0 && tokenIs(token, 'RETURNING')) returningIndex = i;
    if (punctuationIs(token, ';')) {
      terminatorIndex = i;
      break;
    }
  }
  if (!hasConflictClause) {
    let at: number;
    if (returningIndex >= 0) at = tokens[returningIndex].start;
    else if (terminatorIndex >= 0) at = tokens[terminatorIndex].start;
    else {
      const last = tokens.at(-1);
      at = last?.end ?? sql.length;
    }
    edits.push({
      start: at,
      end: at,
      text: returningIndex >= 0 ? ' ON CONFLICT DO NOTHING ' : ' ON CONFLICT DO NOTHING',
    });
  }
  return applyEdits(sql, edits);
}

function rewriteScalarFunctions(sql: string) {
  const calls = collectFunctionCalls(sql, new Set(['max', 'min']));
  const edits: TextEdit[] = [];
  for (const call of calls) {
    const args = functionArgs(sql, call);
    if (args && args.length > 1)
      edits.push({
        start: call.token.start,
        end: call.token.end,
        text: call.token.text.toUpperCase() === 'MAX' ? 'GREATEST' : 'LEAST',
      });
  }
  return applyEdits(sql, edits);
}

function parseJsonPath(path: string) {
  if (path === '$') return [] as string[];
  if (!path.startsWith('$')) return null;
  const parts: string[] = [];
  let i = 1;
  while (i < path.length) {
    if (path[i] === '.') {
      i += 1;
      const start = i;
      while (i < path.length && path[i] !== '.' && path[i] !== '[') i += 1;
      if (i === start) return null;
      parts.push(path.slice(start, i));
      continue;
    }
    if (path[i] === '[') {
      const end = path.indexOf(']', i + 1);
      if (end < 0) return null;
      let part = path.slice(i + 1, end).trim();
      if (
        (part.startsWith("'") && part.endsWith("'")) ||
        (part.startsWith('"') && part.endsWith('"'))
      )
        part = part.slice(1, -1).replaceAll("''", "'").replaceAll('\\"', '"');
      if (!part || /[*#?]/.test(part)) return null;
      parts.push(part);
      i = end + 1;
      continue;
    }
    return null;
  }
  return parts;
}

function jsonPathArray(parts: string[]) {
  return `ARRAY[${parts.map(sqlString).join(',')}]::text[]`;
}

function rewriteJsonFunctions(sql: string) {
  let output = sql;
  for (let pass = 0; pass < 8; pass += 1) {
    const calls = collectFunctionCalls(output, new Set(['json_extract', 'json_valid']));
    const edits: TextEdit[] = [];
    for (const call of calls) {
      const args = functionArgs(output, call);
      if (!args) continue;
      const containsNestedTarget = calls.some(
        (other) =>
          other !== call &&
          other.token.start > call.token.start &&
          other.close.end < call.close.end,
      );
      if (containsNestedTarget) continue;
      if (call.token.text.toLowerCase() === 'json_valid' && args.length === 1) {
        edits.push({
          start: call.token.start,
          end: call.close.end,
          text: `pg_input_is_valid(CAST(${args[0]} AS text), 'jsonb')`,
        });
        continue;
      }
      if (call.token.text.toLowerCase() !== 'json_extract' || args.length !== 2) continue;
      const source = `(${args[0]})::jsonb`;
      const path = decodeSqlString(args[1]);
      const parts = path === undefined ? null : parseJsonPath(path);
      const replacement =
        parts !== null
          ? `${source} #>> ${jsonPathArray(parts)}`
          : `jsonb_path_query_first(${source}, (${args[1]})::jsonpath) #>> ARRAY[]::text[]`;
      edits.push({ start: call.token.start, end: call.close.end, text: replacement });
    }
    const next = applyEdits(output, edits);
    if (next === output) break;
    output = next;
  }
  return output;
}

function rewriteInstr(sql: string) {
  let output = sql;
  for (let pass = 0; pass < 8; pass += 1) {
    const calls = collectFunctionCalls(output, new Set(['instr']));
    const edits: TextEdit[] = [];
    for (const call of calls) {
      const args = functionArgs(output, call);
      if (!args || args.length !== 2) continue;
      const nested = calls.some(
        (other) =>
          other !== call &&
          other.token.start > call.token.start &&
          other.close.end < call.close.end,
      );
      if (nested) continue;
      edits.push({
        start: call.token.start,
        end: call.close.end,
        text: `position(${args[1]} in ${args[0]})`,
      });
    }
    const next = applyEdits(output, edits);
    if (next === output) break;
    output = next;
  }
  return output;
}

function temporalExpression(expr: string, modifiers: string[]) {
  const sourceLiteral = decodeSqlString(expr);
  const unixEpoch = modifiers.some(
    (modifier) => decodeSqlString(modifier)?.toLowerCase() === 'unixepoch',
  );
  let value = unixEpoch
    ? `to_timestamp(${expr}) AT TIME ZONE 'UTC'`
    : sourceLiteral?.toLowerCase() === 'now'
      ? `(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`
      : `((${expr})::timestamptz AT TIME ZONE 'UTC')`;

  for (const modifier of modifiers) {
    const text = decodeSqlString(modifier);
    if (
      !text ||
      text.toLowerCase() === 'unixepoch' ||
      text.toLowerCase() === 'utc' ||
      text.toLowerCase() === 'localtime'
    )
      continue;
    if (text.toLowerCase() === 'start of day') {
      value = `date_trunc('day', ${value})`;
      continue;
    }
    const relative = text.match(
      /^([+-])\s*(\d+(?:\.\d+)?)\s+(second|minute|hour|day|week|month|year)s?$/i,
    );
    if (relative) {
      const [, sign, amount, unit] = relative;
      value = `(${value} ${sign} INTERVAL '${amount} ${unit.toLowerCase()}')`;
      continue;
    }
    return null;
  }
  return value;
}

const SQLITE_FORMATS: Record<string, string> = {
  '%Y': 'YYYY',
  '%y': 'YY',
  '%m': 'MM',
  '%d': 'DD',
  '%e': 'FMDD',
  '%H': 'HH24',
  '%k': 'FMHH24',
  '%M': 'MI',
  '%S': 'SS',
  // SQLite's %f includes seconds, followed by milliseconds.
  '%f': 'SS.MS',
  '%j': 'DDD',
  '%w': 'D',
  '%W': 'WW',
  '%F': 'YYYY"-"MM"-"DD',
  '%T': 'HH24":"MI":"SS',
  '%R': 'HH24":"MI',
};

function postgresFormat(format: string) {
  let result = '';
  let literal = '';
  const flush = () => {
    if (literal) {
      result += `"${literal.replaceAll('"', '""')}"`;
      literal = '';
    }
  };
  for (let i = 0; i < format.length; i += 1) {
    if (format[i] === '%' && i + 1 < format.length) {
      const code = format.slice(i, i + 2);
      const mapped = SQLITE_FORMATS[code];
      if (!mapped) return null;
      flush();
      result += mapped;
      i += 1;
    } else literal += format[i];
  }
  flush();
  return result;
}

function rewriteTemporalFunctions(sql: string) {
  let output = sql;
  for (let pass = 0; pass < 8; pass += 1) {
    const calls = collectFunctionCalls(output, new Set(['datetime', 'strftime', 'date', 'time']));
    const edits: TextEdit[] = [];
    for (const call of calls) {
      const args = functionArgs(output, call);
      if (!args) continue;
      const nested = calls.some(
        (other) =>
          other !== call &&
          other.token.start > call.token.start &&
          other.close.end < call.close.end,
      );
      if (nested) continue;
      const name = call.token.text.toLowerCase();
      if (name === 'strftime') {
        if (args.length < 2) continue;
        const format = decodeSqlString(args[0]);
        const pgFormat = format === undefined ? null : postgresFormat(format);
        const expression = temporalExpression(args[1], args.slice(2));
        if (!pgFormat || !expression) continue;
        edits.push({
          start: call.token.start,
          end: call.close.end,
          text: `to_char(${expression}, ${sqlString(pgFormat)})`,
        });
      } else {
        if (args.length < 1) continue;
        const expression = temporalExpression(args[0], args.slice(1));
        if (!expression) continue;
        const format =
          name === 'date' ? 'YYYY-MM-DD' : name === 'time' ? 'HH24:MI:SS' : 'YYYY-MM-DD HH24:MI:SS';
        edits.push({
          start: call.token.start,
          end: call.close.end,
          text: `to_char(${expression}, ${sqlString(format)})`,
        });
      }
    }
    const next = applyEdits(output, edits);
    if (next === output) break;
    output = next;
  }
  return output;
}

function rewriteBlobType(sql: string) {
  const tokens = tokenizeSql(sql);
  const edits: TextEdit[] = [];
  const typeFollowers = new Set([
    'NOT',
    'NULL',
    'DEFAULT',
    'PRIMARY',
    'UNIQUE',
    'CHECK',
    'REFERENCES',
    'CONSTRAINT',
  ]);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!tokenIs(token, 'BLOB')) continue;
    const next = tokens[i + 1];
    if (punctuationIs(next, ',') || punctuationIs(next, ')')) {
      edits.push({ start: token.start, end: token.end, text: 'BYTEA' });
      continue;
    }
    if (next?.kind === 'word' && typeFollowers.has(next.text.toUpperCase()))
      edits.push({ start: token.start, end: token.end, text: 'BYTEA' });
  }
  return applyEdits(sql, edits);
}

/**
 * PostgreSQL folds unquoted names to lower case.  The Better Auth tables keep
 * SQLite's camelCase columns, so quote only identifiers that visibly carry
 * case (plus the reserved `user` table).  The tokenizer has already excluded
 * strings, comments, and quoted identifiers; lower-case snake_case names are
 * left untouched so ordinary PostgreSQL schemas continue to work.
 */
function rewriteCaseSensitiveIdentifiers(sql: string) {
  const tokens = tokenizeSql(sql);
  const edits: TextEdit[] = [];
  for (const token of tokens) {
    if (token.kind !== 'word') continue;
    if (token.text === 'user' || /[a-z][A-Z]/.test(token.text))
      edits.push({
        start: token.start,
        end: token.end,
        text: `"${token.text.replaceAll('"', '""')}"`,
      });
  }
  return applyEdits(sql, edits);
}

/**
 * SQLite resolves an unqualified column on the right hand side of an
 * `ON CONFLICT ... DO UPDATE` assignment to the row already stored. PostgreSQL
 * reports that spelling as ambiguous, so qualify only the direct self
 * reference (`count=count+1`, for example). Explicit `excluded.*` references
 * and expressions are left as written.
 */
function rewriteUpsertSelfReferences(sql: string) {
  const tokens = tokenizeSql(sql);
  const insertIndex = tokens.findIndex((token) => tokenIs(token, 'INSERT'));
  if (insertIndex < 0) return sql;
  const intoIndex = tokens.findIndex(
    (token, index) => index > insertIndex && tokenIs(token, 'INTO'),
  );
  const targetToken = intoIndex >= 0 ? tokens[intoIndex + 1] : undefined;
  const target = identifierName(targetToken);
  if (!target || !targetToken) return sql;
  let setIndex = -1;
  for (let i = insertIndex + 1; i + 1 < tokens.length; i += 1) {
    if (!tokenIs(tokens[i], 'ON') || !tokenIs(tokens[i + 1], 'CONFLICT')) continue;
    const conflictDepth = tokens[i].depth;
    // An optional conflict target (`ON CONFLICT(key)`) sits between CONFLICT
    // and DO, so locate DO at the ON CONFLICT depth instead of assuming fixed
    // token offsets.
    for (let j = i + 2; j + 1 < tokens.length; j += 1) {
      if (
        tokenIs(tokens[j], 'DO') &&
        tokens[j].depth === conflictDepth &&
        tokenIs(tokens[j + 1], 'UPDATE')
      ) {
        const set = tokens.findIndex(
          (token, index) => index > j + 1 && tokenIs(token, 'SET') && token.depth === conflictDepth,
        );
        if (set >= 0) setIndex = set;
        break;
      }
    }
    break;
  }
  if (setIndex < 0) return sql;
  const setDepth = tokens[setIndex].depth;
  const edits: TextEdit[] = [];
  // Look for the direct shape `column = column [operator ...]`.  Walking
  // token adjacency rather than applying a regexp keeps nested expressions,
  // quoted names, comments, and string literals out of the rewrite.  The
  // first token after SET (and after each top-level comma) is the assignment
  // target, so a matching first RHS token is the only self reference that
  // needs qualification.
  let assignmentStart = setIndex + 1;
  for (let i = setIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.depth !== setDepth) continue;
    if (punctuationIs(token, ',') || tokenIs(token, 'WHERE') || tokenIs(token, 'RETURNING')) {
      qualifyAssignment(tokens, assignmentStart, i, setDepth, target, edits);
      assignmentStart = i + 1;
      if (!punctuationIs(token, ',')) {
        assignmentStart = tokens.length;
        break;
      }
      continue;
    }
    if (punctuationIs(token, ';')) {
      qualifyAssignment(tokens, assignmentStart, i, setDepth, target, edits);
      assignmentStart = tokens.length;
      break;
    }
  }
  if (assignmentStart < tokens.length)
    qualifyAssignment(tokens, assignmentStart, tokens.length, setDepth, target, edits);
  return applyEdits(sql, edits);
}

function qualifyAssignment(
  tokens: SqlToken[],
  start: number,
  end: number,
  depth: number,
  target: string,
  edits: TextEdit[],
) {
  if (start >= end) return;
  const lhs = identifierName(tokens[start]);
  if (!lhs) return;
  const equals = tokens.findIndex(
    (token, index) =>
      index >= start && index < end && token.depth === depth && punctuationIs(token, '='),
  );
  if (equals < 0) return;
  const rhs = tokens[equals + 1];
  if (!rhs || identifierName(rhs)?.toLowerCase() !== lhs.toLowerCase()) return;
  edits.push({ start: rhs.start, end: rhs.end, text: `${target}.${rhs.text}` });
}

const POSTGRES_BOOLEAN_COLUMNS = new Set([
  'emailverified',
  'twofactorenabled',
  'backuped',
  'backedup',
  'verified',
  'user_verified_required',
]);

const POSTGRES_TIMESTAMP_COLUMNS = new Set([
  'expiresat',
  'createdat',
  'updatedat',
  'lockeduntil',
  'accesstokenexpiresat',
  'refreshtokenexpiresat',
]);

function identifierName(token: SqlToken | undefined) {
  if (!token) return undefined;
  if (token.kind === 'word') return token.text;
  if (token.kind === 'quoted' && token.text.startsWith('"') && token.text.endsWith('"'))
    return token.text.slice(1, -1).replaceAll('""', '"');
  if (token.kind === 'quoted' && token.text.startsWith('[') && token.text.endsWith(']'))
    return token.text.slice(1, -1);
  return undefined;
}

function placeholderNumber(token: SqlToken | undefined) {
  if (!token || token.kind !== 'word') return undefined;
  const match = token.text.match(/^\$([1-9][0-9]*)$/);
  return match ? Number(match[1]) : undefined;
}

function matchingParen(tokens: SqlToken[], openIndex: number) {
  const open = tokens[openIndex];
  if (!punctuationIs(open, '(')) return -1;
  for (let i = openIndex + 1; i < tokens.length; i += 1)
    if (punctuationIs(tokens[i], ')') && tokens[i].depth === open.depth + 1) return i;
  return -1;
}

function insertValueColumns(tokens: SqlToken[]) {
  const insertIndex = tokens.findIndex((token) => tokenIs(token, 'INSERT'));
  if (insertIndex < 0) return undefined;
  const valuesIndex = tokens.findIndex(
    (token, index) => index > insertIndex && tokenIs(token, 'VALUES'),
  );
  if (valuesIndex < 0) return undefined;
  const columnOpenIndex = tokens.findIndex(
    (token, index) => index > insertIndex && index < valuesIndex && punctuationIs(token, '('),
  );
  const valueOpenIndex = tokens.findIndex(
    (token, index) => index > valuesIndex && punctuationIs(token, '('),
  );
  if (columnOpenIndex < 0 || valueOpenIndex < 0) return undefined;
  const columnCloseIndex = matchingParen(tokens, columnOpenIndex);
  const valueCloseIndex = matchingParen(tokens, valueOpenIndex);
  if (columnCloseIndex < 0 || valueCloseIndex < 0) return undefined;
  const columns: string[] = [];
  let columnStart = columnOpenIndex + 1;
  for (let i = columnOpenIndex + 1; i < columnCloseIndex; i += 1) {
    if (punctuationIs(tokens[i], ',') && tokens[i].depth === tokens[columnOpenIndex].depth + 1) {
      const column = identifierName(tokens[columnStart]);
      if (column) columns.push(column);
      columnStart = i + 1;
    }
  }
  const lastColumn = identifierName(tokens[columnStart]);
  if (lastColumn) columns.push(lastColumn);
  if (!columns.length) return undefined;

  const values: Array<number | undefined> = [];
  let valueStart = valueOpenIndex + 1;
  for (let i = valueOpenIndex + 1; i < valueCloseIndex; i += 1) {
    if (punctuationIs(tokens[i], ',') && tokens[i].depth === tokens[valueOpenIndex].depth + 1) {
      values.push(placeholderNumber(tokens[valueStart]));
      valueStart = i + 1;
    }
  }
  values.push(placeholderNumber(tokens[valueStart]));
  const result = new Map<number, string>();
  for (let i = 0; i < Math.min(columns.length, values.length); i += 1) {
    const number = values[i];
    if (number !== undefined) result.set(number, columns[i]);
  }
  return result;
}

/** Find a column on the left-hand side of `=`, `>`, `<`, or a scalar MAX arg. */
function placeholderPredicateColumn(tokens: SqlToken[], index: number) {
  const previous = tokens[index - 1];
  if (punctuationIs(previous, ',')) {
    const functionName = tokens[index - 4];
    const open = tokens[index - 3];
    if (
      functionName &&
      open &&
      (tokenIs(functionName, 'MAX') || tokenIs(functionName, 'GREATEST')) &&
      punctuationIs(open, '(')
    )
      return identifierName(tokens[index - 2]);
  }
  let cursor = index - 1;
  let sawOperator = false;
  while (cursor >= 0 && cursor >= index - 4) {
    const token = tokens[cursor];
    if (token.kind === 'punctuation' && ['=', '>', '<', '!'].includes(token.text)) {
      sawOperator = true;
      cursor -= 1;
      continue;
    }
    if (sawOperator) return identifierName(token);
    break;
  }
  return undefined;
}

function parameterColumns(sql: string) {
  const tokens = tokenizeSql(sql);
  const result = insertValueColumns(tokens) ?? new Map<number, string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const number = placeholderNumber(tokens[i]);
    if (number === undefined || result.has(number)) continue;
    const column = placeholderPredicateColumn(tokens, i);
    if (column) result.set(number, column);
  }
  return result;
}

function normalizeParameters(sql: string, params: unknown[] | undefined) {
  if (!params?.length) return params ?? [];
  const columns = parameterColumns(sql);
  return params.map((value, offset) => {
    const column = columns.get(offset + 1)?.toLowerCase();
    if (column && POSTGRES_BOOLEAN_COLUMNS.has(column) && (value === 0 || value === 1))
      return value === 1;
    if (
      column &&
      POSTGRES_TIMESTAMP_COLUMNS.has(column) &&
      typeof value === 'number' &&
      Number.isFinite(value)
    )
      return new Date(value);
    return value;
  });
}

function rewriteSqliteMaster(sql: string) {
  const tokens = tokenizeSql(sql);
  const fromIndex = tokens.findIndex((token) => tokenIs(token, 'FROM'));
  if (fromIndex < 0 || !tokenIs(tokens[fromIndex + 1], 'SQLITE_MASTER')) return sql;
  const edits: TextEdit[] = [
    {
      start: tokens[fromIndex + 1].start,
      end: tokens[fromIndex + 1].end,
      text: 'information_schema.tables',
    },
  ];
  const selectIndex = tokens.findIndex(
    (token, index) => index < fromIndex && tokenIs(token, 'SELECT'),
  );
  if (selectIndex >= 0 && tokenIs(tokens[selectIndex + 1], 'NAME'))
    edits.push({
      start: tokens[selectIndex + 1].start,
      end: tokens[selectIndex + 1].end,
      text: 'table_name AS name',
    });
  const whereIndex = tokens.findIndex(
    (token, index) => index > fromIndex && tokenIs(token, 'WHERE'),
  );
  if (whereIndex < 0) return applyEdits(sql, edits);
  edits.push({
    start: tokens[whereIndex].end,
    end: tokens[whereIndex].end,
    text: ' table_schema=current_schema() AND',
  });
  for (let i = whereIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.depth !== tokens[whereIndex].depth) continue;
    if (
      tokenIs(token, 'TYPE') &&
      decodeSqlString(sql.slice(tokens[i + 2]?.start ?? 0, tokens[i + 2]?.end ?? 0)) === 'table'
    ) {
      edits.push({ start: token.start, end: token.end, text: 'table_type' });
      const literal = tokens[i + 2];
      if (literal)
        edits.push({ start: literal.start, end: literal.end, text: sqlString('BASE TABLE') });
    }
    if (tokenIs(token, 'NAME') && punctuationIs(tokens[i + 1], '='))
      edits.push({ start: token.start, end: token.end, text: 'table_name' });
  }
  return applyEdits(sql, edits);
}

function containsChangesCall(sql: string) {
  return collectFunctionCalls(sql, new Set(['changes'])).length > 0;
}

function isMutationGuard(sql: string) {
  const tokens = tokenizeSql(sql);
  for (let i = 0; i + 3 < tokens.length; i += 1) {
    if (
      tokenIs(tokens[i], 'INSERT') &&
      tokenIs(tokens[i + 1], 'INTO') &&
      tokenIs(tokens[i + 2], 'MUTATION_GUARD') &&
      tokenIs(tokens[i + 3], 'VALUES')
    ) {
      return containsChangesCall(sql);
    }
  }
  return false;
}

function replaceChangesCallWithOne(sql: string) {
  const calls = collectFunctionCalls(sql, new Set(['changes']));
  return applyEdits(
    sql,
    calls.map((call) => ({ start: call.token.start, end: call.close.end, text: '1' })),
  );
}

function isPragma(sql: string) {
  const tokens = tokenizeSql(sql);
  return tokenIs(tokens[0], 'PRAGMA');
}

/**
 * Translate one SQLite-compatible statement into PostgreSQL SQL.  The
 * function is exported so migration tooling and focused tests can inspect the
 * exact boundary translation without needing a running server.
 */
export function translateSql(sql: string) {
  let translated = sql;
  if (isPragma(translated)) return 'SELECT 1';
  translated = rewriteSqliteMaster(translated);
  translated = rewriteInsertOrIgnore(translated);
  translated = rewriteJsonFunctions(translated);
  translated = rewriteInstr(translated);
  translated = rewriteScalarFunctions(translated);
  translated = rewriteTemporalFunctions(translated);
  translated = rewriteBlobType(translated);
  translated = rewriteUpsertSelfReferences(translated);
  translated = rewriteCaseSensitiveIdentifiers(translated);
  translated = rewriteQuestionPlaceholders(translated);
  return translated;
}

/** Explicit aliases are useful to callers that want to name the source dialect. */
export const translateSqliteSql = translateSql;
export const translateSqliteQuery = translateSql;

function commandName(sql: string, result: QueryResultLike) {
  const command = result.command?.toUpperCase();
  if (command) return command;
  const match = sql.trimStart().match(/^([A-Za-z]+)/);
  return match?.[1]?.toUpperCase() ?? '';
}

function finalResult(response: QueryResponse): QueryResultLike {
  if (Array.isArray(response)) return response.at(-1) ?? { rows: [], rowCount: 0 };
  return response;
}

const NUMERIC_RESULT_KEYS =
  /^(?:count|version|revision|counter|attempts|(?:.+_)(?:count|revision|version|attempts))$/i;

/** Restore the SQLite-facing row representation used by the shared business code. */
function normalizeResultValue(value: unknown, key?: string): unknown {
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map((item) => normalizeResultValue(item));
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        normalizeResultValue(childValue, childKey),
      ]),
    );
  }
  if (key && NUMERIC_RESULT_KEYS.test(key) && typeof value === 'string' && /^-?\d+$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
  }
  return value;
}

function normalizeResultRows(rows: unknown[] | undefined) {
  return (rows ?? []).map((row) => normalizeResultValue(row) as Record<string, unknown>);
}

function safeSqlState(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * pg includes useful diagnostic fields such as `detail`, which can contain a
 * rejected row and therefore private values.  Known SQLSTATEs are normalized
 * to stable, value-free messages before crossing the Database boundary.
 */
export class PostgresDatabaseError extends Error {
  readonly sqlState?: string;
  readonly retryable: boolean;
  readonly code?: string;

  constructor(message: string, sqlState?: string, retryable = false) {
    super(message);
    this.name = 'PostgresDatabaseError';
    this.sqlState = sqlState;
    this.code = sqlState;
    this.retryable = retryable;
  }
}

function normalizeDatabaseError(error: unknown): Error {
  if (error instanceof PostgresDatabaseError) return error;
  const state = safeSqlState(error);
  if (!state) return error instanceof Error ? error : new Error('DATABASE_ERROR');
  switch (state) {
    case '23505':
      return new PostgresDatabaseError('UNIQUE constraint violation', state);
    case '23514':
      return new PostgresDatabaseError('CHECK constraint violation', state);
    case '23503':
      return new PostgresDatabaseError('FOREIGN KEY constraint violation', state);
    case '23502':
      return new PostgresDatabaseError('NOT NULL constraint violation', state);
    case '40001':
    case '40P01':
      return new PostgresDatabaseError('TRANSACTION_RETRYABLE', state, true);
    default:
      return new PostgresDatabaseError('DATABASE_ERROR', state);
  }
}

function mutationGuardError() {
  return new PostgresDatabaseError(
    'mutation_guard: expected exactly one changed row',
    'MUTATION_GUARD',
  );
}

function isLikelyPool(source: PostgresQueryable | PostgresPoolLike) {
  if (source instanceof Pool) return true;
  const candidate = source as unknown as { totalCount?: unknown; connect?: unknown };
  return typeof candidate.connect === 'function' && 'totalCount' in candidate;
}

function queryValues(params: unknown[] | undefined) {
  // pg's public type uses `any[]`; retaining unknown[] in this package keeps
  // the Database interface honest while the driver still receives the same
  // values without string interpolation.
  return params ? [...params] : [];
}

/**
 * Adapt a connected pg Client or a pg Pool to the repository Database
 * interface.  Pool batches acquire one PoolClient for BEGIN/COMMIT/ROLLBACK;
 * a Client batch uses that same Client for every statement.  No batch uses
 * `pool.query`, which would allow transaction statements to land on different
 * connections.
 */
export function postgresDatabase(source: PostgresQueryable | PostgresPoolLike): Database {
  const pool = isLikelyPool(source) ? (source as PostgresPoolLike) : undefined;
  // A single closure per adapter prevents concurrent Client batches from
  // interleaving BEGIN/COMMIT on one connection.
  let queueTail = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>) => {
    const run = queueTail.then(operation, operation);
    queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const execute = async (target: PostgresQueryable, sql: string, params: unknown[] = []) => {
    try {
      return finalResult(await target.query({ text: sql, values: queryValues(params) }));
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  };

  const all = async <T>(sql: string, params: unknown[] = []) => {
    if (isPragma(sql)) return [] as T[];
    if (containsChangesCall(sql))
      throw new PostgresDatabaseError(
        'changes() is only supported as a mutation guard inside batch()',
        'MUTATION_GUARD',
      );
    const operation = async () => {
      const translated = translateSql(sql);
      const result = await execute(
        pool ?? source,
        translated,
        normalizeParameters(translated, params),
      );
      return normalizeResultRows(result.rows) as T[];
    };
    return pool ? operation() : serialized(operation);
  };

  const batch = async (queries: Query[]) => {
    const operation = async () => {
      let connection: PostgresQueryable = source;
      let release: (() => void) | undefined;
      if (pool) {
        const pooled = await pool.connect();
        connection = pooled;
        release = pooled.release.bind(pooled);
      }
      let transactionStarted = false;
      try {
        await execute(connection, 'BEGIN');
        transactionStarted = true;
        let lastChangeCount = 0;
        for (const query of queries) {
          if (!query.sql.trim() || isPragma(query.sql)) continue;
          const guard = isMutationGuard(query.sql);
          if (guard && lastChangeCount !== 1) throw mutationGuardError();
          if (containsChangesCall(query.sql) && !guard)
            throw new PostgresDatabaseError(
              'changes() is only supported as a mutation guard inside batch()',
              'MUTATION_GUARD',
            );
          const translated = guard
            ? replaceChangesCallWithOne(translateSql(query.sql))
            : translateSql(query.sql);
          const result = await execute(
            connection,
            translated,
            normalizeParameters(translated, query.params),
          );
          const command = commandName(translated, result);
          if (['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(command))
            lastChangeCount = result.rowCount ?? 0;
        }
        await execute(connection, 'COMMIT');
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) {
          try {
            await execute(connection, 'ROLLBACK');
          } catch {
            // Preserve the original operation or guard error.
          }
        }
        throw normalizeDatabaseError(error);
      } finally {
        release?.();
      }
    };
    return pool ? operation() : serialized(operation);
  };

  return { all, batch };
}
