// The one command's reader and chooser, in awk: on the server there is no TypeScript and no
// round trip to the board, so what the board does between Look and its run (core/server-look.ts
// readRoundOne, readServerFacts; core/server-plan.ts chooseCase, stepOneNeeds and the parts of
// buildPlan and undoPlan that pick the steps and their values; core/server-plain.ts plainPlan;
// core/server-script.ts runScript, which puts the steps into a run) runs here, written once more.
// Kept equal to the board's by test/core/server-oneshot.test.ts, which runs both on every Look
// fixture and on changed copies of them and compares the case, the reasons, the plan in plain words
// and the run byte for byte. The steps themselves are the board's own text
// (core/server-oneshot-templates.ts), filled in here.
//
// POSIX awk only (mawk on Debian and Ubuntu): no gawk extensions, no regex intervals, no
// length() of an array; bytes, with LC_ALL=C. Modes (-v mode=…), reading stdin:
//   r2       round one's output → the shape of round two and its values, or none
//   apply    the step templates (`@@ab-dict` … ), `@@ab-round1`, round one, `@@ab-round2`, round
//            two (-v plan_id, run_id, at) → what was found and the plan, in plain words; `plan
//            <key>`, its address and its steps' titles, then `@@ab-run` and the run; or why not
//   undo     the same for the record's Undo
//   bind     value lines, `@@ab-template`, a template → the template filled in
//   progress a run's output → its steps as they go, one line each (titles in ENVIRON AB_TITLES)
// Values go out as `v <name> <value>`, a list as `e <name>` then `w <name> <item>` lines, many lines
// as `l <name>`, the lines, `@@ab-end-value`. Pure, with no node: import.

/** Turns a text into an awk string literal. */
export function awkString(s: string): string {
  let out = '"'
  for (const ch of s) {
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\r') out += '\\r'
    else out += ch
  }
  return `${out}"`
}

/** The awk program, its constants and data set in BEGIN by `preamble` (core/server-oneshot.ts). */
export const AWK_BODY = String.raw`
function init(    i) {
  for (i = 1; i < 256; i++) ORD[sprintf("%c", i)] = i
  NUL = sprintf("%c", 1)
  SQ = sprintf("%c", 39)
  BQ = sprintf("%c", 96)
  NPORTS = split("80 443 8443 8480 8481", PORTS, " ")
  part = 1
  intemplate = 0
}

# ---------------------------------------------------------------------------------------------
# Words and text

function trim(s) { sub(/^[ \t\n\r\f\v]+/, "", s); sub(/[ \t\n\r\f\v]+$/, "", s); return s }
function lastindex(s, t,    i, k) { k = 0; while ((i = index(substr(s, k + 1), t)) > 0) k += i; return k }
function startswith(s, t) { return substr(s, 1, length(t)) == t }
function endswith(s, t) { return length(s) >= length(t) && substr(s, length(s) - length(t) + 1) == t }
function base(p) { return substr(p, lastindex(p, "/") + 1) }
function dirof(p,    k) { k = lastindex(p, "/"); return k > 1 ? substr(p, 1, k - 1) : "/" }
function isline(s) { return index(s, "\n") == 0 && index(s, "\r") == 0 }
function isplainpath(s,    n, a, i) {
  if (!startswith(s, "/") || !isline(s)) return 0
  n = split(s, a, "/")
  for (i = 1; i <= n; i++) if (a[i] == "..") return 0
  return 1
}
function iscontainerid(s) { return s ~ /^[0-9a-f]+$/ && length(s) == 64 }
function ishex64(s) { return s ~ /^[0-9a-f]+$/ && length(s) == 64 }
function resolveat(a) { return index(a, ":") ? "[" a "]" : a }
# a value a script takes: no quote, backslash, dollar, backquote or control character
function safe(s,    i, c) {
  if (index(s, SQ) || index(s, "\"") || index(s, "\\") || index(s, "$") || index(s, BQ)) return 0
  for (i = 1; i <= length(s); i++) { c = ORD[substr(s, i, 1)]; if (c < 32 || c == 127) return 0 }
  return 1
}
function shquote(s,    n, a, i, out) {
  n = split(s, a, SQ); out = a[1]
  for (i = 2; i <= n; i++) out = out SQ "\\" SQ SQ a[i]
  return SQ out SQ
}
function q(s) { return (s != "" && s !~ /[^A-Za-z0-9_@%+=:,.\/-]/) ? s : shquote(s) }
function sqq(s,    n, a, i, out) {
  s = q(s); n = split(s, a, SQ); out = a[1]
  for (i = 2; i <= n; i++) out = out SQ "\\" SQ SQ a[i]
  return out
}
# a JSON string, as JSON.stringify writes one
function jstr(s,    out, i, c, o) {
  out = ""
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1); o = ORD[c]
    if (c == "\"") out = out "\\\""
    else if (c == "\\") out = out "\\\\"
    else if (o == 10) out = out "\\n"
    else if (o == 13) out = out "\\r"
    else if (o == 9) out = out "\\t"
    else if (o == 8) out = out "\\b"
    else if (o == 12) out = out "\\f"
    else if (o < 32) out = out sprintf("\\u%04x", o)
    else out = out c
  }
  return "\"" out "\""
}

# ---------------------------------------------------------------------------------------------
# JSON (JSON.parse's grammar): a value's type in JT[p], its text in JV[p] (a string decoded),
# an array's or object's size in JN[p], an object's keys in order in JK[p, i]; members at p SUBSEP key,
# items at p SUBSEP i (from 1). Returns the root's path, "" on an error.

function jparse(s,    root) {
  JS = s; JP = 1; JL = length(s); JERR = 0
  root = "j" (++JCOUNT)
  jvalue(root); jws()
  if (JERR || JP <= JL) return ""
  return root
}
function jws() { while (JP <= JL && index(" \t\n\r", substr(JS, JP, 1))) JP++ }
function jvalue(p,    c, k, n, m) {
  jws()
  if (JP > JL) { JERR = 1; return }
  c = substr(JS, JP, 1)
  if (c == "{") {
    JT[p] = "o"; JN[p] = 0; JP++; jws()
    if (substr(JS, JP, 1) == "}") { JP++; return }
    while (!JERR) {
      jws()
      if (substr(JS, JP, 1) != "\"") { JERR = 1; return }
      k = jstring()
      jws()
      if (substr(JS, JP, 1) != ":") { JERR = 1; return }
      JP++
      if (!((p, k) in JT)) JK[p, ++JN[p]] = k
      jvalue(p SUBSEP k)
      jws()
      c = substr(JS, JP, 1)
      if (c == ",") { JP++; continue }
      if (c == "}") { JP++; return }
      JERR = 1
    }
    return
  }
  if (c == "[") {
    JT[p] = "a"; JN[p] = 0; JP++; jws()
    if (substr(JS, JP, 1) == "]") { JP++; return }
    while (!JERR) {
      n = ++JN[p]
      jvalue(p SUBSEP n)
      jws()
      c = substr(JS, JP, 1)
      if (c == ",") { JP++; continue }
      if (c == "]") { JP++; return }
      JERR = 1
    }
    return
  }
  if (c == "\"") { JT[p] = "s"; JV[p] = jstring(); return }
  if (substr(JS, JP, 4) == "true") { JT[p] = "b"; JV[p] = "true"; JP += 4; return }
  if (substr(JS, JP, 5) == "false") { JT[p] = "b"; JV[p] = "false"; JP += 5; return }
  if (substr(JS, JP, 4) == "null") { JT[p] = "n"; JV[p] = "null"; JP += 4; return }
  if (match(substr(JS, JP), /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/)) {
    JT[p] = "d"; JV[p] = substr(JS, JP, RLENGTH); JP += RLENGTH; return
  }
  JERR = 1
}
function jstring(    out, c, h, n) {
  out = ""; JP++
  while (JP <= JL) {
    c = substr(JS, JP, 1)
    if (c == "\"") { JP++; return out }
    if (ORD[c] < 32) { JERR = 1; return out }
    if (c == "\\") {
      c = substr(JS, JP + 1, 1); JP += 2
      if (c == "n") out = out "\n"
      else if (c == "t") out = out "\t"
      else if (c == "r") out = out "\r"
      else if (c == "b") out = out sprintf("%c", 8)
      else if (c == "f") out = out sprintf("%c", 12)
      else if (c == "/" || c == "\\" || c == "\"") out = out c
      else if (c == "u") {
        h = tolower(substr(JS, JP, 4))
        if (h !~ /^[0-9a-f][0-9a-f][0-9a-f][0-9a-f]$/) { JERR = 1; return out }
        n = hexval(h); JP += 4
        if (n >= 55296 && n < 56320 && substr(JS, JP, 2) == "\\u") {
          h = tolower(substr(JS, JP + 2, 4))
          if (h ~ /^[0-9a-f][0-9a-f][0-9a-f][0-9a-f]$/ && hexval(h) >= 56320 && hexval(h) < 57344) {
            n = 65536 + (n - 55296) * 1024 + (hexval(h) - 56320); JP += 6
          }
        }
        out = out utf8(n)
      } else { JERR = 1; return out }
      continue
    }
    out = out c; JP++
  }
  JERR = 1
  return out
}
function hexval(h,    i, n) { n = 0; for (i = 1; i <= length(h); i++) n = n * 16 + index("0123456789abcdef", substr(h, i, 1)) - 1; return n }
function utf8(n) {
  if (n < 128) return sprintf("%c", n)
  if (n < 2048) return sprintf("%c%c", 192 + int(n / 64), 128 + n % 64)
  if (n < 65536) return sprintf("%c%c%c", 224 + int(n / 4096), 128 + int(n / 64) % 64, 128 + n % 64)
  return sprintf("%c%c%c%c", 240 + int(n / 262144), 128 + int(n / 4096) % 64, 128 + int(n / 64) % 64, 128 + n % 64)
}
function jstrof(p) { return JT[p] == "s" ? JV[p] : "" }

# ---------------------------------------------------------------------------------------------
# Look's output: sections (core/server-look.ts sections, at, all, parts)

function sections(r, names,    want, total, i, n, line, name, cur, found) {
  total = split(names, want, " ")
  for (i = 1; i <= total; i++) WANT[r, want[i]] = 1
  cur = ""; found = 0
  n = (r == 1 ? N1 : N2)
  for (i = 1; i <= n; i++) {
    line = (r == 1 ? R1[i] : R2[i])
    if (line == "@@end") return found == total
    if (line ~ /^@@section [^ \t\n\r\f\v]+$/) {
      name = substr(line, 11)
      if (!((r, name) in WANT) || ((r, name) in GOT)) return 0
      GOT[r, name] = 1; found++; cur = name; SN[r, name] = 0
      continue
    }
    if (cur != "") SL[r, cur, ++SN[r, cur]] = line
  }
  return 0
}
function at(r, s, key,    i, l, n, k) {
  n = SN[r, s]; k = "@@" key
  for (i = 1; i <= n; i++) {
    l = SL[r, s, i]
    if (l == k) return ""
    if (startswith(l, k " ")) return substr(l, length(k) + 2)
  }
  return NUL
}
function nn(v) { return v == NUL ? "" : v }
function allof(r, s, key, OUT,    i, l, n, m, k) {
  n = SN[r, s]; m = 0; k = "@@" key " "
  for (i = 1; i <= n; i++) { l = SL[r, s, i]; if (startswith(l, k)) OUT[++m] = substr(l, length(k) + 1) }
  return m
}
function hasline(r, s, line,    i, n) {
  n = SN[r, s]
  for (i = 1; i <= n; i++) if (SL[r, s, i] == line) return 1
  return 0
}
# the lines of each @@part of a section: PART[r, s, name, i], PARTN[r, s, name]
function parts(r, s,    i, n, l, cur) {
  n = SN[r, s]; cur = ""
  for (i = 1; i <= n; i++) {
    l = SL[r, s, i]
    if (l ~ /^@@part [^ \t\n\r\f\v]+$/) { cur = substr(l, 8); PARTN[r, s, cur] = 0; PARTHAS[r, s, cur] = 1; continue }
    if (cur != "") PART[r, s, cur, ++PARTN[r, s, cur]] = l
  }
}
function fields(s, F) { return split(trim(s), F, /[ \t\n\r\f\v]+/) }

# ---------------------------------------------------------------------------------------------
# Round one (core/server-look.ts readRoundOne)

function osvalue(raw,    c, s, out, i) {
  c = substr(raw, 1, 1)
  if ((c == "\"" || c == SQ) && endswith(raw, c) && length(raw) > 1) {
    s = substr(raw, 2, length(raw) - 2); out = ""
    for (i = 1; i <= length(s); i++) {
      if (substr(s, i, 1) == "\\" && i < length(s)) { i++; out = out substr(s, i, 1) } else out = out substr(s, i, 1)
    }
    return out
  }
  return raw
}
function read_distro(    i, n, l, k, V) {
  n = SN[1, "os"]
  for (i = 1; i <= n; i++) {
    l = SL[1, "os", i]
    if (match(l, /^[A-Z_]+=/)) { k = substr(l, 1, RLENGTH - 1); OS[k] = osvalue(substr(l, RLENGTH + 1)); OSHAS[k] = 1 }
  }
  DI_id = ("ID" in OSHAS) ? OS["ID"] : ""
  DI_version = ("VERSION_ID" in OSHAS) ? OS["VERSION_ID"] : ""
  DI_supported = 0
  if (DI_id == "debian" || DI_id == "ubuntu") {
    n = split(SUPPORTED[DI_id], V, " ")
    for (i = 1; i <= n; i++) if (V[i] == DI_version) DI_supported = 1
  }
}

# ss lines into LS[tag, k, ...]: port, address, its processes' names and pids
function read_listens(r, s, tag, partname,    i, n, l, F, nf, st, j, local, colon, port, rest, inner, k, cnt, np) {
  cnt = 0
  n = (partname == "" ? SN[r, s] : PARTN[r, s, partname])
  for (i = 1; i <= n; i++) {
    l = (partname == "" ? SL[r, s, i] : PART[r, s, partname, i])
    if (partname == "" && startswith(l, "@@")) continue
    nf = fields(l, F)
    st = 0
    for (j = 1; j <= nf; j++) if (F[j] == "LISTEN") { st = j; break }
    if (!st || st + 3 > nf) continue
    local = F[st + 3]
    if (local == "") continue
    colon = lastindex(local, ":")
    port = substr(local, colon + 1)
    if (colon == 0) continue
    if (port == "") port = 0
    else if (port !~ /^[0-9]+$/) continue
    cnt++
    LS[tag, cnt, "port"] = port + 0
    LS[tag, cnt, "addr"] = substr(local, 1, colon - 1)
    np = 0; rest = l
    while (match(rest, /\("([^"\\]|\\.)*",pid=[0-9]+,fd=[0-9]+\)/)) {
      inner = substr(rest, RSTART + 2, RLENGTH - 3)
      k = lastindex(inner, "\",pid=")
      np++
      LS[tag, cnt, "name", np] = substr(inner, 1, k - 1)
      inner = substr(inner, k + 6)
      LS[tag, cnt, "pid", np] = substr(inner, 1, index(inner, ",") - 1) + 0
      rest = substr(rest, RSTART + RLENGTH)
    }
    LS[tag, cnt, "np"] = np
  }
  LSN[tag] = cnt
}
function read_pids(    i, n, l, cur) {
  n = SN[1, "ports"]; cur = ""
  for (i = 1; i <= n; i++) {
    l = SL[1, "ports", i]
    if (l ~ /^@@pid [0-9]+$/) { cur = substr(l, 7) + 0; PIDN[cur] = 0; PIDHAS[cur] = 1; continue }
    if (cur != "" && l ~ /^[0-9]+:/) PIDL[cur, ++PIDN[cur]] = l
  }
}
# where a process runs, from its cgroup: PL_kind (unit, container, other) and PL_val
function place(pid,    i, n, line, rest, k, path, np, P, j, part, m) {
  n = (pid in PIDHAS) ? PIDN[pid] : 0
  line = ""
  for (i = 1; i <= n; i++) if (startswith(PIDL[pid, i], "0::")) { line = PIDL[pid, i]; break }
  if (line == "") for (i = 1; i <= n; i++) if (index(PIDL[pid, i], ":name=systemd:")) { line = PIDL[pid, i]; break }
  if (line == "" && n >= 1) line = PIDL[pid, 1]
  path = ""
  k = index(line, ":")
  if (k) { rest = substr(line, k + 1); k = index(rest, ":"); if (k) path = substr(rest, k + 1) }
  m = split(path, P, "/"); np = 0
  for (i = 1; i <= m; i++) if (P[i] != "") Q[++np] = P[i]
  for (j = np; j >= 1; j--) {
    part = Q[j]
    if (part ~ /^docker-[0-9a-f]+\.scope$/ && length(part) == 77) { PL_kind = "container"; PL_val = substr(part, 8, 64); return }
    if (ishex64(part) && j > 1 && Q[j - 1] == "docker") { PL_kind = "container"; PL_val = part; return }
    if (endswith(part, ".service")) { PL_kind = "unit"; PL_val = part; return }
    if (endswith(part, ".scope")) { PL_kind = "other"; PL_val = ""; return }
  }
  PL_kind = "other"; PL_val = ""
}
function cprogram(c,    first) {
  first = base(C_cmd[c, 0])
  return (endswith(first, ".sh") && C_cmd[c, 1] != "") ? base(C_cmd[c, 1]) : first
}
function bound(port,    c, j) {
  for (c = 1; c <= CN; c++) for (j = 1; j <= C_portn[c]; j++) if (C_ppub[c, j] == port) return c
  return 0
}
# who holds a port (core/server-look.ts holderOf): HK, HU, HI, HP, HS (a split's programs)
function holder(port,    k, n, kind, unit, id, prog, c, key, nh, i, j, progs, seen) {
  n = 0
  for (k = 1; k <= LSN["ss"]; k++) if (LS["ss", k, "port"] == port) n++
  if (!n) {
    c = DOCKER ? bound(port) : 0
    if (c) { HK[port] = "container"; HI[port] = C_id[c]; HP[port] = cprogram(c); HU[port] = "" }
    else { HK[port] = "free"; HI[port] = ""; HP[port] = ""; HU[port] = "" }
    return
  }
  nh = 0
  for (k = 1; k <= LSN["ss"]; k++) {
    if (LS["ss", k, "port"] != port) continue
    if (LS["ss", k, "np"] == 0) { kind = "process"; unit = ""; id = ""; prog = "" }
    else {
      prog = LS["ss", k, "name", 1]
      c = (prog == "docker-proxy" || prog == "dockerd") && DOCKER ? bound(port) : 0
      place(LS["ss", k, "pid", 1])
      if (c) { kind = "container"; id = C_id[c]; prog = cprogram(c); unit = "" }
      else if (PL_kind == "container") { kind = "container"; id = PL_val; unit = "" }
      else if (PL_kind == "unit") { kind = "unit"; unit = PL_val; id = "" }
      else { kind = "process"; unit = ""; id = "" }
    }
    key = kind SUBSEP unit SUBSEP id SUBSEP prog
    if (!((port, key) in HSEEN)) {
      HSEEN[port, key] = 1; nh++
      HX_kind[port, nh] = kind; HX_unit[port, nh] = unit; HX_id[port, nh] = id; HX_prog[port, nh] = prog
    }
  }
  if (nh == 1) { HK[port] = HX_kind[port, 1]; HU[port] = HX_unit[port, 1]; HI[port] = HX_id[port, 1]; HP[port] = HX_prog[port, 1]; return }
  HK[port] = "split"; HU[port] = ""; HI[port] = ""; HP[port] = ""; progs = ""
  for (i = 1; i <= nh; i++) {
    if ((port, "p", HX_prog[port, i]) in HSEEN) continue
    HSEEN[port, "p", HX_prog[port, i]] = 1
    progs = progs (progs == "" ? "" : ", ") HX_prog[port, i]
  }
  HS[port] = progs
}
# a "<json string> <json string>" pair, into PAIR1 and PAIR2; 0 when it is not one
function jsonpair(s, rest,    a, b) {
  if (!match(s, /^"([^"\\]|\\.)*"/)) return 0
  a = substr(s, 1, RLENGTH); rest = substr(s, RLENGTH + 1)
  if (substr(rest, 1, 1) != " ") return 0
  rest = substr(rest, 2)
  PAIR1 = a; PAIR2 = rest
  return 1
}
function jsonof(s,    root) { root = jparse(s); if (root == "") UNREADABLE = 1; return root }
function read_docker(    n, i, l, sv, sec, root, j, opts, nopts, c, id, a, rest, p, k) {
  if (hasline(1, "docker", "@@none")) { DOCKER = 0; return }
  DOCKER = 1
  sv = trim(nn(at(1, "docker", "server"))); sec = trim(nn(at(1, "docker", "security")))
  nopts = 0
  if (startswith(sec, "[")) {
    root = jsonof(sec)
    if (root != "" && JT[root] == "a") for (j = 1; j <= JN[root]; j++) OPT[++nopts] = jstrof(root SUBSEP j)
  }
  D_version = (sv ~ /^[0-9]+\.[0-9]+/) ? sv : ""
  n = SN[1, "docker"]
  for (i = 1; i <= n; i++) {
    l = SL[1, "docker", i]
    if (!startswith(l, "@@network ")) continue
    rest = substr(l, 11)
    if (jsonpair(rest) && PAIR2 ~ /^"([^"\\]|\\.)*"$/) {
      a = jsonof(PAIR1); root = jsonof(PAIR2)
      if (a != "" && root != "") DRV[jstrof(a)] = jstrof(root)
    }
  }
  CN = 0; c = 0
  for (i = 1; i <= n; i++) {
    l = SL[1, "docker", i]
    if (l ~ /^@@container [^ \t\n\r\f\v]+$/) {
      id = substr(l, 13)
      if (!iscontainerid(id)) UNREADABLE = 1
      c = ++CN; C_id[c] = id; CL[c] = 0
      continue
    }
    if (c && l != "" && !startswith(l, "@@")) CLINE[c, ++CL[c]] = l
  }
  for (c = 1; c <= CN; c++) read_container(c)
  D_podman = 0
  k = allof(1, "docker", "cli", CLI)
  for (i = 1; i <= k; i++) if (tolower(CLI[i]) ~ /podman/) D_podman = 1
  D_rootless = named(nopts, "rootless") || (D_version == "" && allof(1, "docker", "user-socket", USOCK) > 0)
  D_userns = named(nopts, "userns")
}
function named(nopts, name,    i, m, P, j) {
  for (i = 1; i <= nopts; i++) { m = split(OPT[i], P, ","); for (j = 1; j <= m; j++) if (P[j] == "name=" name) return 1 }
  return 0
}
function cone(c, key,    i, l) {
  for (i = 1; i <= CL[c]; i++) { l = CLINE[c, i]; if (startswith(l, key " ")) return jsonof(substr(l, length(key) + 2)) }
  return ""
}
function read_container(c,    p, i, l, root, j, m, k, key, b, rest, a, nl) {
  p = cone(c, "netmode"); C_host[c] = (p != "" && jstrof(p) == "host")
  C_netn[c] = 0
  for (i = 1; i <= CL[c]; i++) {
    l = CLINE[c, i]
    if (startswith(l, "network ")) {
      root = jsonof(substr(l, 9)); m = ++C_netn[c]
      C_netname[c, m] = root == "" ? "" : jstrof(root)
      C_netdrv[c, m] = (C_netname[c, m] in DRV) ? DRV[C_netname[c, m]] : ""
      C_netuser[c, m] = !(C_netname[c, m] == "bridge" || C_netname[c, m] == "host" || C_netname[c, m] == "none")
    }
  }
  C_mountn[c] = 0
  root = cone(c, "mounts")
  if (root != "" && JT[root] == "a") for (j = 1; j <= JN[root]; j++) {
    p = root SUBSEP j
    if (JT[p] != "o") continue
    k = jstrof(p SUBSEP "Type")
    if (!((p, "Type") in JT) || JT[p SUBSEP "Type"] != "s" || (k != "bind" && k != "volume")) continue
    m = ++C_mountn[c]
    C_mtype[c, m] = k; C_msrc[c, m] = jstrof(p SUBSEP "Source"); C_mdst[c, m] = jstrof(p SUBSEP "Destination")
  }
  C_portn[c] = 0
  root = cone(c, "ports")
  if (root != "" && JT[root] == "o") for (j = 1; j <= JN[root]; j++) {
    key = JK[root, j]
    if (key !~ /^[0-9]+\/tcp$/) continue
    p = root SUBSEP key
    if (JT[p] != "a") continue
    for (k = 1; k <= JN[p]; k++) {
      b = p SUBSEP k
      if (JT[b] != "o") continue
      m = ++C_portn[c]
      C_ppriv[c, m] = substr(key, 1, index(key, "/") - 1) + 0
      a = jstrof(b SUBSEP "HostPort")
      C_ppub[c, m] = (a ~ /^[0-9]+$/) ? a + 0 : (a == "" ? 0 : -1)
      C_pip[c, m] = jstrof(b SUBSEP "HostIp")
    }
  }
  for (i = 1; i <= CL[c]; i++) {
    l = CLINE[c, i]
    if (!startswith(l, "label ")) continue
    rest = substr(l, 7)
    if (!match(rest, /^"([^"\\]|\\.)*" /)) continue
    a = jsonof(substr(rest, 1, RLENGTH - 1)); root = jsonof(substr(rest, RLENGTH + 1))
    if (a != "" && root != "") { C_label[c, jstrof(a)] = jstrof(root); C_haslabel[c, jstrof(a)] = 1 }
  }
  root = cone(c, "args"); p = cone(c, "path")
  C_cmd[c, 0] = p == "" ? "" : jstrof(p)
  C_cmdn[c] = 1
  if (root != "" && JT[root] == "a") for (j = 1; j <= JN[root]; j++) C_cmd[c, C_cmdn[c]++] = jstrof(root SUBSEP j)
  p = cone(c, "name"); C_name[c] = p == "" ? "" : jstrof(p); sub(/^\//, "", C_name[c])
  p = cone(c, "image"); C_image[c] = p == "" ? "" : jstrof(p)
}
function argvof(v,    i, k, rest, n, A, out) {
  i = index(v, "argv[]=")
  if (!i) return ""
  rest = substr(v, i + 7); k = index(rest, " ; ignore_errors=")
  if (!k) return ""
  return substr(rest, 1, k - 1)
}
# the units (core/server-look.ts readUnits): U_has[name], U_es[name] (argv, spaces between), U_user, U_group, U_wd
function read_units(    n, i, l, eq) {
  n = SN[1, "systemd"]
  SYSTEMD = hasline(1, "systemd", "@@running")
  unitflush()
  for (i = 1; i <= n; i++) {
    l = SL[1, "systemd", i]
    if (startswith(l, "@@")) continue
    if (trim(l) == "") { unitflush(); continue }
    eq = index(l, "=")
    if (eq > 1) { UKV[substr(l, 1, eq - 1)] = substr(l, eq + 1); UKVHAS[substr(l, 1, eq - 1)] = 1 }
  }
  unitflush()
}
function unitflush(    id) {
  if (("Id" in UKVHAS) && UKV["Id"] != "") {
    id = UKV["Id"]
    if (("LoadState" in UKVHAS) && UKV["LoadState"] == "not-found") U_has[id] = 0
    else {
      U_has[id] = 1
      U_es[id] = argvof(("ExecStart" in UKVHAS) ? UKV["ExecStart"] : "")
      U_user[id] = ("User" in UKVHAS) ? UKV["User"] : ""
      U_group[id] = ("Group" in UKVHAS) ? UKV["Group"] : ""
      U_wd[id] = ("WorkingDirectory" in UKVHAS) ? UKV["WorkingDirectory"] : ""
    }
  }
  split("", UKV); split("", UKVHAS)
}
# a unit's argv into A (from 0); its length
function unitargv(id, A,    n, P, i, m) {
  m = 0
  if (!U_has[id]) return 0
  n = split(U_es[id], P, " ")
  for (i = 1; i <= n; i++) if (P[i] != "") A[m++] = P[i]
  return m
}
function read_folder(    d, g, m, P, M, i, s) {
  d = nn(at(1, "folder", "dir"))
  FOLDER = (d ~ /^[0-9]+ [^ \t\n\r\f\v]+ [^ \t\n\r\f\v]+ [0-9]+$/)
  if (FOLDER) { split(d, P, " "); FO_mode = P[1]; FO_owner = P[2]; FO_group = P[3]; FO_gid = P[4] + 0 }
  g = nn(at(1, "folder", "group"))
  split(g, P, ":")
  FO_members = ""
  m = split(P[4], M, ",")
  for (i = 1; i <= m; i++) if (M[i] != "") FO_members = FO_members (FO_members == "" ? "" : ", ") M[i]
}
# sshd's settings for the tunnel user (FENCE), and step 1's parts besides (core/server-look.ts
# readFence, readStepOne): S1 when Look read them (an "@@user" line); S1_user, S1_uid, S1_group,
# S1_shell, S1_ours (the board made it), S1_admin (the login Look ran as), S1_groupleft (no user,
# a group of its name left), S1_keys (none, same or other), S1_keysdir, S1_include
function read_stepone(    i, n, l, u, F, k) {
  n = SN[1, "fence"]
  for (i = 1; i <= n; i++) {
    l = SL[1, "fence", i]
    if (l ~ /^[a-z0-9]+ /) { k = index(l, " "); FENCE[substr(l, 1, k - 1)] = substr(l, k + 1) }
  }
  u = at(1, "fence", "user")
  S1 = u != NUL
  if (!S1) return
  S1_user = u ~ /^[0-9]+([ \t\n\r\f\v]+[^ \t\n\r\f\v]+)?[ \t\n\r\f\v]*$/
  S1_uid = S1_user && fields(u, F) >= 1 ? F[1] + 0 : 0
  S1_group = (S1_user && fields(u, F) >= 2) ? F[2] : ""
  S1_shell = trim(nn(at(1, "fence", "user-shell")))
  S1_ours = hasline(1, "fence", "@@user-ours")
  S1_admin = hasline(1, "fence", "@@user-admin")
  S1_groupleft = !S1_user && hasline(1, "fence", "@@user-group")
  k = at(1, "fence", "keys")
  S1_keys = (k == "none" || k == "same") ? k : "other"
  S1_keysdir = hasline(1, "fence", "@@keys-dir")
  S1_include = hasline(1, "fence", "@@include")
}
function read_record(    n, i, start, body, l) {
  n = SN[1, "record"]; start = 0
  for (i = 1; i <= n; i++) if (SL[1, "record", i] == "@@file") { start = i; break }
  REC_present = start > 0
  body = ""
  if (start) for (i = start + 1; i <= n; i++) {
    l = SL[1, "record", i]
    if (startswith(l, "@@lock")) break
    body = body (i == start + 1 ? "" : "\n") l
  }
  REC_text = trim(body)
  LOCK_held = hasline(1, "record", "@@lock held")
}
function read_host(    s, k, i, F, P, m) {
  s = tolower(trim(nn(at(1, "host", "selinux"))))
  H_selinux = (s == "enforcing" || s == "permissive" || s == "disabled") ? s : ""
  H_forwarding = trim(nn(at(1, "host", "forward"))) == "1"
  k = allof(1, "host", "forwarder", F); H_forwarders = ""
  for (i = 1; i <= k; i++) H_forwarders = H_forwarders (H_forwarders == "" ? "" : ", ") F[i]
  k = allof(1, "host", "fetch", F)
  H_fetch = (k >= 1 && (F[1] == "curl" || F[1] == "wget")) ? F[1] : ""
  k = allof(1, "host", "missing", F)
  for (i = 1; i <= k; i++) H_missing[F[i]] = 1
  k = allof(1, "host", "package", F); H_conflicts = 0
  for (i = 1; i <= k; i++) { m = split(F[i], P, " "); if (m >= 2 && P[2] == "installed") H_conflicts++ }
}
function read_dns(    i, F, nf, a, k, n) {
  parts(1, "dns"); DNS_dn = 0; DNS_ln = 0
  n = PARTN[1, "dns", "domain"]
  for (i = 1; i <= n; i++) {
    nf = fields(PART[1, "dns", "domain", i], F); a = nf >= 1 ? F[1] : ""
    if (a != "" && !(("d", a) in DNSSEEN)) { DNSSEEN["d", a] = 1; DNS_d[++DNS_dn] = a }
  }
  n = PARTN[1, "dns", "local"]
  for (i = 1; i <= n; i++) {
    nf = fields(PART[1, "dns", "local", i], F); a = nf >= 4 ? F[4] : ""
    k = index(a, "/"); if (k) a = substr(a, 1, k - 1)
    if (a != "" && !(("l", a) in DNSSEEN)) { DNSSEEN["l", a] = 1; DNS_l[++DNS_ln] = a }
  }
}
function round_one(    i) {
  if (!sections(1, "os ports docker systemd fence folder record host dns")) return 0
  UNREADABLE = 0
  read_docker()
  read_listens(1, "ports", "ss", "")
  read_pids()
  for (i = 1; i <= NPORTS; i++) holder(PORTS[i])
  read_distro(); read_units(); read_folder(); read_stepone(); read_record(); read_host(); read_dns()
  return !UNREADABLE
}

# ---------------------------------------------------------------------------------------------
# What round two reads (core/server-look.ts caddyTarget, nginxTarget)

function flag(A, n, name,    i) {
  for (i = 0; i < n; i++) {
    if (A[i] == name) return (i + 1 < n) ? A[i + 1] : ""
    if (startswith(A[i], name "=")) return substr(A[i], length(name) + 2)
  }
  return ""
}
function adapterof(A, n, config,    given, nm) {
  given = flag(A, n, "--adapter")
  if (given != "") return given
  if (config == "") return ""
  nm = base(config)
  return (startswith(nm, "Caddyfile") || endswith(nm, ".caddyfile")) ? "caddyfile" : "json"
}
function containerof(id,    c) { for (c = 1; c <= CN; c++) if (C_id[c] == id) return c; return 0 }
# TG_where (unit, container, or "" for none), TG_container, TG_config, TG_hostpath (NUL for none), TG_mount, TG_adapter, TG_resume, TG_bin, TG_cmd0
function caddy_target(    A, n, given, wd, config, c, i, best, bl, d, fm, j, dst) {
  TG_where = ""
  if (HK[443] == "unit" && HU[443] == "caddy.service" && HP[443] == "caddy" && U_has["caddy.service"]) {
    n = unitargv("caddy.service", A)
    given = flag(A, n, "--config"); wd = U_wd["caddy.service"]
    config = (given != "" && !startswith(given, "/") && startswith(wd, "/")) ? (dewslash(wd) "/" given) : given
    TG_where = "unit"; TG_container = ""; TG_config = config
    TG_hostpath = isplainpath(config) ? config : NUL
    TG_mount = ""; TG_adapter = adapterof(A, n, config); TG_resume = 0
    for (i = 0; i < n; i++) if (A[i] == "--resume") TG_resume = 1
    TG_bin = (n > 0 && isplainpath(A[0])) ? A[0] : "caddy"
    return
  }
  if (HK[443] != "container" || HP[443] != "caddy" || !iscontainerid(HI[443])) return
  c = containerof(HI[443])
  if (!c) return
  for (i = 0; i < C_cmdn[c]; i++) CA_ARGV[i] = C_cmd[c, i]
  config = flag(CA_ARGV, C_cmdn[c], "--config")
  if (!isline(config) || !isline(C_cmd[c, 0])) return
  TG_mount = ""; TG_hostpath = NUL
  if (startswith(config, "/")) {
    fm = 0
    for (j = 1; j <= C_mountn[c]; j++) if (C_mtype[c, j] == "bind" && C_mdst[c, j] == config) { fm = j; break }
    best = 0; bl = -1
    for (j = 1; j <= C_mountn[c]; j++) {
      dst = dewslash(C_mdst[c, j])
      if (startswith(config, dst "/") && length(C_mdst[c, j]) > bl) { best = j; bl = length(C_mdst[c, j]) }
    }
    if (fm) { TG_mount = "file"; TG_hostpath = C_msrc[c, fm] }
    else if (best) {
      TG_mount = C_mtype[c, best] == "bind" ? "folder" : "volume"
      TG_hostpath = dewslash(C_msrc[c, best]) substr(config, length(dewslash(C_mdst[c, best])) + 1)
    }
  }
  TG_where = "container"; TG_container = C_id[c]; TG_config = config
  if (TG_hostpath != NUL && !isplainpath(TG_hostpath)) TG_hostpath = NUL
  TG_adapter = adapterof(CA_ARGV, C_cmdn[c], config); TG_resume = 0
  for (i = 0; i < C_cmdn[c]; i++) if (C_cmd[c, i] == "--resume") TG_resume = 1
  TG_cmd0 = C_cmd[c, 0] != "" ? C_cmd[c, 0] : "caddy"
}
function dewslash(s) { sub(/\/$/, "", s); return s }
function nginx_target(    A, n, conf) {
  NT = (HK[80] == "unit" || HK[80] == "process") && HP[80] == "nginx" || (HK[443] == "unit" || HK[443] == "process") && HP[443] == "nginx"
  if (!NT) return
  n = unitargv("nginx.service", A)
  NT_bin = (n > 0 && isplainpath(A[0])) ? A[0] : "nginx"
  conf = flag(A, n, "-c")
  NT_conf = (conf != "" && isplainpath(conf)) ? conf : ""
}

# ---------------------------------------------------------------------------------------------
# Round two (core/server-look.ts readServerFacts)

function round_two(    names, ok) {
  CADDY = 0; NGINX = 0
  if (TG_where == "" && !NT) return 1
  names = (TG_where != "" ? "caddy" : "") (TG_where != "" && NT ? " " : "") (NT ? "nginx" : "")
  if (!sections(2, names)) return 0
  UNREADABLE = 0
  if (TG_where != "") read_caddy()
  if (NT) read_nginx()
  return !UNREADABLE
}
function read_caddy(    i, n, l, root, p, j, h, sha, F, v, k) {
  CADDY = 1; CA_where = TG_where; CA_container = TG_container; CA_config = TG_config; CA_hostpath = TG_hostpath
  CA_mount = TG_mount; CA_adapter = TG_adapter; CA_resume = TG_resume
  parts(2, "caddy")
  CA_hostn = 0; CA_adminoff = 0; CA_autohttpsoff = 0
  n = PARTN[2, "caddy", "adapt"]
  for (i = 1; i <= n; i++) {
    l = PART[2, "caddy", "adapt", i]
    if (l == "\"admin\":{\"disabled\":true") CA_adminoff = 1
    if (l == "\"automatic_https\":{\"disable\":true") CA_autohttpsoff = 1
    if (!startswith(l, "\"host\":[")) continue
    root = jsonof("{" l "}")
    if (root == "") continue
    p = root SUBSEP "host"
    if (JT[root] == "o" && ((root, "host") in JT) && JT[p] == "a")
      for (j = 1; j <= JN[p]; j++) {
        h = jstrof(p SUBSEP j)
        if (!(h in CAHSEEN)) { CAHSEEN[h] = 1; CA_host[++CA_hostn] = h }
      }
  }
  k = fields(nn(at(2, "caddy", "sha256")), F); sha = k >= 1 ? F[1] : ""
  CA_sha = ishex64(sha) ? sha : ""
  v = nn(at(2, "caddy", "version"))
  CA_version = match(v, /v?[0-9]+\.[0-9]+\.[0-9]+[^ \t\n\r\f\v]*/) ? substr(v, RSTART, RLENGTH) : ""
  sub(/^v/, "", CA_version)
  CA_newline = trim(nn(at(2, "caddy", "newline"))) == "1"
  read_listens(2, "caddy", "listen", "listen")
  CA_address = fetchaddress()
}
function near(a) { return (a == "0.0.0.0" || a == "*" || a == "[::]" || a == "::" || a == "") ? "127.0.0.1" : a }
function fetchaddress(    k, c, j) {
  for (k = 1; k <= LSN["listen"]; k++) if (LS["listen", k, "port"] == 443) return near(LS["listen", k, "addr"])
  c = containerof(CA_container)
  if (c) for (j = 1; j <= C_portn[c]; j++) if (C_ppub[c, j] == 443) return near(C_pip[c, j])
  return "127.0.0.1"
}
function read_nginx(    i, n, l, F, nf, a, port, j) {
  NGINX = 1; NX_confd = 0; NX_ln = 0; NX_nn = 0
  n = SN[2, "nginx"]
  for (i = 1; i <= n; i++) {
    l = trim(SL[2, "nginx", i]); sub(/;$/, "", l)
    nf = split(l, F, /[ \t\n\r\f\v]+/)
    if (F[1] == "include" && nf >= 2 && F[2] == "/etc/nginx/conf.d/*.conf") NX_confd = 1
    if (F[1] == "listen" && nf >= 2 && F[2] != "") {
      a = F[2]
      port = (a ~ /^[0-9]+$/) ? a : substr(a, lastindex(a, ":") + 1)
      if (port == "80" && !(("l", a) in NXSEEN)) { NXSEEN["l", a] = 1; NX_l[++NX_ln] = a }
    }
    if (F[1] == "server_name") for (j = 2; j <= nf; j++)
      if (F[j] != "_" && F[j] != "\"\"" && !(("n", F[j]) in NXSEEN)) { NXSEEN["n", F[j]] = 1; NX_n[++NX_nn] = F[j] }
  }
}

# ---------------------------------------------------------------------------------------------
# The record (core/server-plan.ts setupRecord, whose, holdsSetup, dedupe)

function isgroupname(s) { return s ~ /^[A-Za-z0-9_][A-Za-z0-9_.-]*\$?$/ && length(s) <= (endswith(s, "$") ? 33 : 32) }
function isimageref(s) { return s ~ /^[a-z0-9][a-z0-9._\/:@-]*$/ && length(s) <= 255 }
function ispackage(s) { return s ~ /^[a-z0-9][a-z0-9.+-]*$/ && length(s) <= 100 }
function isport(p) { return JT[p] == "d" && JV[p] + 0 == int(JV[p] + 0) && JV[p] + 0 >= 1 && JV[p] + 0 <= 65535 }
function isuser(s) { return s ~ /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/ && length(s) <= 32 }
function issocket(s,    n, P, i, folder) {
  if (s !~ /^(\/[A-Za-z0-9._-]+)+$/) return 0
  n = split(s, P, "/")
  for (i = 1; i <= n; i++) if (P[i] == "." || P[i] == "..") return 0
  if (length(s) > 100) return 0
  folder = dirof(s)
  return !(folder == "/" || folder == "/tmp" || folder == "/var/tmp" || folder == "/dev/shm" || folder == "/run" || folder == "/var/run")
}
function isdomain(s,    n, P, i) {
  if (length(s) > 253 || s !~ /^[a-z0-9.-]+$/) return 0
  n = split(s, P, ".")
  if (n < 2) return 0
  for (i = 1; i <= n; i++) if (P[i] == "" || length(P[i]) > 63 || P[i] ~ /^-/ || P[i] ~ /-$/) return 0
  return 1
}
# the record read back (setupRecord): 1 and REC_*, RI_* when it is the board's own
function setup_record(    root, p, k, i, n, it, kind, folder) {
  root = jparse(REC_text)
  if (root == "" || JT[root] != "o") return 0
  if (JT[root SUBSEP "v"] != "d" || JV[root SUBSEP "v"] + 0 != 1) return 0
  if (JT[root SUBSEP "id"] != "s" || JV[root SUBSEP "id"] !~ /^[A-Za-z0-9._-]+$/ || length(JV[root SUBSEP "id"]) > 64) return 0
  if (JT[root SUBSEP "at"] != "s" || !isline(JV[root SUBSEP "at"])) return 0
  REC_state = jstrof(root SUBSEP "state")
  if (JT[root SUBSEP "state"] != "s" || !(REC_state == "running" || REC_state == "applied" || REC_state == "rolled-back" || REC_state == "rollback-failed")) return 0
  REC_case = jstrof(root SUBSEP "case")
  if (JT[root SUBSEP "case"] != "s" || !(REC_case in CASES)) return 0
  p = root SUBSEP "pair"
  if (JT[p] != "o" || JT[p SUBSEP "user"] != "s" || JT[p SUBSEP "socket"] != "s") return 0
  REC_user = JV[p SUBSEP "user"]; REC_socket = JV[p SUBSEP "socket"]
  if (!isline(REC_user) || REC_user == "" || !isline(REC_socket) || !isplainpath(REC_socket)) return 0
  if (JT[root SUBSEP "domain"] != "s" || JT[root SUBSEP "address"] != "s") return 0
  REC_domain = JV[root SUBSEP "domain"]; REC_address = JV[root SUBSEP "address"]
  if (!isline(REC_domain) || REC_domain == "" || !isline(REC_address)) return 0
  p = root SUBSEP "publicPort"
  if (!((root, "publicPort") in JT)) return 0
  if (JT[p] == "n") REC_port = ""
  else if (isport(p)) REC_port = JV[p] + 0
  else return 0
  if (!isuser(REC_user) || !issocket(REC_socket) || !isdomain(REC_domain)) return 0
  p = root SUBSEP "items"
  if (JT[p] != "a") return 0
  folder = dirof(REC_socket); n = JN[p]; REC_n = 0
  for (i = 1; i <= n; i++) if (!record_item(p SUBSEP i, folder)) return 0
  return 1
}
function rs(p, k) { return (JT[p SUBSEP k] == "s") ? JV[p SUBSEP k] : NUL }
function record_item(p, folder,    kind, k, a, j, ok, m) {
  if (JT[p] != "o") return 0
  kind = rs(p, "kind"); k = ++REC_n; RI_kind[k] = kind
  if (kind == "file") {
    a = rs(p, "path")
    if (!(a == CADDY_FILE || a == SITE_FILE || a == NGINX_FILE) || !ishex64(rs(p, "sha256"))) return 0
    RI_path[k] = a; RI_sha[k] = rs(p, "sha256"); return 1
  }
  if (kind == "line") {
    a = rs(p, "file")
    if (a == NUL || !isplainpath(a) || rs(p, "line") != IMPORT_LINE) return 0
    RI_file[k] = a; return 1
  }
  if (kind == "block") {
    a = rs(p, "file")
    if (a == NUL || !isplainpath(a) || rs(p, "begin") != BLOCK_BEGIN || rs(p, "end") != BLOCK_END) return 0
    RI_file[k] = a; return 1
  }
  if (kind == "backup") {
    a = rs(p, "of")
    if (a == NUL || !isplainpath(a) || rs(p, "path") == NUL || !isplainpath(rs(p, "path")) || !startswith(rs(p, "path"), BACKUPS_DIR "/")) return 0
    RI_of[k] = a; RI_path[k] = rs(p, "path"); return 1
  }
  if (kind == "group") {
    if (rs(p, "path") != folder || !isgroupname(rs(p, "from")) || !isgroupname(rs(p, "to"))) return 0
    RI_path[k] = folder; RI_from[k] = rs(p, "from"); RI_to[k] = rs(p, "to"); return 1
  }
  if (kind == "container") {
    a = rs(p, "name")
    if (!(a == CADDY_NAME || a == SOCKET_NAME) || rs(p, "setup") == NUL || !isline(rs(p, "setup"))) return 0
    RI_name[k] = a; RI_setup[k] = rs(p, "setup"); return 1
  }
  if (kind == "volume") {
    a = rs(p, "name")
    if (!(a == VOLUME1 || a == VOLUME2)) return 0
    RI_name[k] = a; return 1
  }
  if (kind == "image") {
    a = rs(p, "ref")
    if (a == NUL || !isimageref(a) || JT[p SUBSEP "before"] != "b") return 0
    RI_ref[k] = a; RI_before[k] = JV[p SUBSEP "before"] == "true"; return 1
  }
  # step 1's parts, the board's only when it made them
  if (kind == "user") { if (rs(p, "name") != REC_user) return 0; RI_name[k] = REC_user; return 1 }
  if (kind == "folder") { if (rs(p, "path") != folder) return 0; RI_path[k] = folder; return 1 }
  if (kind == "keys") {
    if (rs(p, "path") != KEYS_DIR "/" REC_user || JT[p SUBSEP "dir"] != "b") return 0
    RI_path[k] = KEYS_DIR "/" REC_user; RI_dir[k] = JV[p SUBSEP "dir"] == "true"; return 1
  }
  if (kind == "fence") {
    a = rs(p, "path")
    if (a != FENCE_FILE && a != SSHD_CONFIG) return 0
    RI_path[k] = a; return 1
  }
  if (kind == "docker") {
    a = p SUBSEP "packages"; m = p SUBSEP "files"
    if (JT[a] != "a" || JT[m] != "a") return 0
    RI_pk[k] = ""; RI_fl[k] = ""
    for (j = 1; j <= JN[a]; j++) { if (JT[a SUBSEP j] != "s" || !ispackage(JV[a SUBSEP j])) return 0; RI_pk[k] = RI_pk[k] (j > 1 ? SUBSEP : "") JV[a SUBSEP j] }
    for (j = 1; j <= JN[m]; j++) { if (JT[m SUBSEP j] != "s" || !(JV[m SUBSEP j] in DOCKERFILE)) return 0; RI_fl[k] = RI_fl[k] (j > 1 ? SUBSEP : "") JV[m SUBSEP j] }
    RI_pkn[k] = JN[a]; RI_fln[k] = JN[m]
    return 1
  }
  return 0
}
# no public port wanted: the one the record's case gives (its address that case's for the domain)
function whose(    port) {
  if (REC_user != W_USER || REC_socket != W_SOCKET) return "other"
  if (REC_domain != W_DOMAIN) return "update"
  if (W_PORT == "") return REC_address == caseaddress(REC_case) ? "same" : "update"
  port = REC_port == "" ? 443 : REC_port
  return port + 0 == W_PORT + 0 ? "same" : "update"
}
# the board's address for a case (core/server-plan.ts ADDRESS)
function caseaddress(c) { return "https://" W_DOMAIN (c == "4a" || c == "4b" ? ":8443" : "") }
function holds_setup(    k) {
  if (REC_state != "rolled-back") return 1
  for (k = 1; k <= REC_n; k++) if (RI_kind[k] != "docker" && !(RI_kind[k] == "image" && RI_before[k])) return 1
  return 0
}
function itemkey(k,    kind) {
  kind = RI_kind[k]
  if (kind == "file" || kind == "backup" || kind == "group" || kind == "folder" || kind == "keys" || kind == "fence") return kind " " RI_path[k]
  if (kind == "line" || kind == "block") return kind " " RI_file[k]
  if (kind == "container" || kind == "volume" || kind == "user") return kind " " RI_name[k]
  if (RI_kind[k] == "image") return "image " RI_ref[k]
  return "docker"
}
# the record's items each once (dedupe): the newest of each, an image "there before" only when
# every run found it so, the first Docker item; DD[i] their numbers in order, DDN of them
function dedupe(    k, key, i, j, n, was) {
  n = 0
  for (k = 1; k <= REC_n; k++) {
    key = itemkey(k); was = 0
    for (i = 1; i <= n; i++) if (itemkey(DD[i]) == key) { was = DD[i]; for (j = i; j < n; j++) DD[j] = DD[j + 1]; n--; break }
    if (RI_kind[k] == "image" && was) { RI_before[k] = RI_before[k] && RI_before[was]; DD[++n] = k }
    else if (RI_kind[k] == "docker" && was) DD[++n] = was
    else DD[++n] = k
  }
  DDN = n
}
# an item as JSON, as the board writes it
function itemjson(k,    s, n, P, i) {
  if (RI_kind[k] == "file") return "{\"kind\":\"file\",\"path\":" jstr(RI_path[k]) ",\"sha256\":" jstr(RI_sha[k]) "}"
  if (RI_kind[k] == "line") return "{\"kind\":\"line\",\"file\":" jstr(RI_file[k]) ",\"line\":" jstr(IMPORT_LINE) "}"
  if (RI_kind[k] == "block") return "{\"kind\":\"block\",\"file\":" jstr(RI_file[k]) ",\"begin\":" jstr(BLOCK_BEGIN) ",\"end\":" jstr(BLOCK_END) "}"
  if (RI_kind[k] == "backup") return "{\"kind\":\"backup\",\"of\":" jstr(RI_of[k]) ",\"path\":" jstr(RI_path[k]) "}"
  if (RI_kind[k] == "group") return "{\"kind\":\"group\",\"path\":" jstr(RI_path[k]) ",\"from\":" jstr(RI_from[k]) ",\"to\":" jstr(RI_to[k]) "}"
  if (RI_kind[k] == "container") return "{\"kind\":\"container\",\"name\":" jstr(RI_name[k]) ",\"setup\":" jstr(RI_setup[k]) "}"
  if (RI_kind[k] == "volume") return "{\"kind\":\"volume\",\"name\":" jstr(RI_name[k]) "}"
  if (RI_kind[k] == "image") return "{\"kind\":\"image\",\"ref\":" jstr(RI_ref[k]) ",\"before\":" (RI_before[k] ? "true" : "false") "}"
  if (RI_kind[k] == "user") return "{\"kind\":\"user\",\"name\":" jstr(RI_name[k]) "}"
  if (RI_kind[k] == "folder" || RI_kind[k] == "fence") return "{\"kind\":\"" RI_kind[k] "\",\"path\":" jstr(RI_path[k]) "}"
  if (RI_kind[k] == "keys") return "{\"kind\":\"keys\",\"path\":" jstr(RI_path[k]) ",\"dir\":" (RI_dir[k] ? "true" : "false") "}"
  s = "{\"kind\":\"docker\",\"packages\":["
  n = split(RI_pk[k], P, SUBSEP); for (i = 1; i <= RI_pkn[k]; i++) s = s (i > 1 ? "," : "") jstr(P[i])
  s = s "],\"files\":["
  n = split(RI_fl[k], P, SUBSEP); for (i = 1; i <= RI_fln[k]; i++) s = s (i > 1 ? "," : "") jstr(P[i])
  return s "]}"
}

# ---------------------------------------------------------------------------------------------
# Choosing the case (core/server-plan.ts chooseCase)

function isfree(p) { return HK[p] == "free" }
function isours(p,    c) { if (HK[p] != "container") return 0; c = containerof(HI[p]); return c && ((c, ROLE_LABEL) in C_haslabel) }
function iscaddy(p,    c) {
  if (HK[p] == "unit" || HK[p] == "process") return HP[p] == "caddy"
  if (HK[p] != "container") return 0
  if (HP[p] == "caddy" || (CADDY && CA_where == "container" && CA_container == HI[p])) return 1
  c = containerof(HI[p])
  return c && C_image[c] ~ /(^|\/)caddy([:@]|$)/
}
function holdername(p,    c) {
  if (HK[p] == "unit") return HU[p]
  if (HK[p] == "container") { c = containerof(HI[p]); return c ? C_name[c] : substr(HI[p], 1, 12) }
  if (HK[p] == "process") return HP[p]
  if (HK[p] == "split") return HS[p]
  return ""
}
function manual(why) { CHOICE = ""; WHY = why; return 1 }
function chose(c, key, a, b, va, vb) { CHOICE = c; WHYKEY = key; WP1 = a; WV1 = va; WP2 = b; WV2 = vb; return 1 }
function hostlimits(    why, i, n, T) {
  why = ""
  n = split("flock setsid timeout sha256sum ss gzip", T, " ")
  if (!DI_supported) why = why " os"
  else for (i = 1; i <= n; i++) if (T[i] in H_missing) { why = why " os"; break }
  if (H_selinux == "enforcing") why = why " selinux"
  if (DOCKER && D_podman) why = why " podman"
  if (DOCKER && D_rootless) why = why " rootless"
  if (DOCKER && D_userns) why = why " userns"
  needs()
  if (!FOLDER && !NEED) why = why " folder"
  if (ownerslogin()) why = why " tunnelUser"
  if (NEED && NEED_user && S1_groupleft) why = why " tunnelGroup"
  return substr(why, 2)
}
# the tunnel's user is a login of the owner's (core/server-plan.ts ownersLogin): there, not made
# by the board, and root, a person's, the admin's, or one with a shell to log in with
function ownerslogin() {
  if (!S1 || !S1_user || S1_ours) return 0
  return S1_uid == 0 || S1_uid >= 1000 || S1_admin || S1_shell !~ /(^|\/)(nologin|false)$/
}
# what step 1 lacks, which Apply makes first (core/server-plan.ts stepOneNeeds): NEED when the
# board makes any of it (Look read step 1, and the board has its key); NEED_user, NEED_folder,
# NEED_keys (make, write or none), NEED_fence (a setting of the fence not in force)
function needs(    k) {
  NEED = S1 && W_KEY != ""
  NEED_user = 0; NEED_folder = 0; NEED_keys = ""; NEED_fence = 0
  if (!NEED) return
  NEED_user = !S1_user
  NEED_folder = !FOLDER
  NEED_keys = S1_keys == "none" ? "make" : S1_keys == "other" ? "write" : ""
  for (k in FENCEW) if (!(k in FENCE) || FENCE[k] != FENCEW[k]) NEED_fence = 1
}
function portsfree(list,    n, P, i) {
  n = split(list, P, " ")
  for (i = 1; i <= n; i++) if (!isfree(P[i]) && !isours(P[i])) return 0
  return 1
}
function owncase(c, key, held) {
  if (!DOCKER && H_conflicts > 0) return manual("dockerConflicts")
  if (!portsfree(c == "4a" ? "8443" : c == "4b" ? "8443 8480" : "")) return manual("portTaken")
  return chose(c, key, held == NUL ? "" : "holder", "", held, "")
}
function inlist(x, A, n,    i) { for (i = 1; i <= n; i++) if (A[i] == x) return 1; return 0 }
function casefour(held) {
  if (isfree(80)) return owncase("4a", "server.case.4a", held)
  if (!(HK[80] == "unit" && HP[80] == "nginx" && NGINX && NX_confd)) return manual("other80")
  if (inlist(W_DOMAIN, NX_n, NX_nn)) return manual("domainServed")
  if (!SYSTEMD) return manual("noSystemd")
  return owncase("4b", "server.case.4b", held)
}
function caddyproblems(    why, mine) {
  why = ""
  if (HK[443] == "process") why = why " noSystemd"
  if (HK[443] == "unit" && !SYSTEMD) why = why " noSystemd"
  mine = CADDY && (HK[443] == "container" ? (CA_where == "container" && CA_container == HI[443]) : CA_where == "unit")
  if (!CADDY || !mine || CA_config == "") return substr(why " twoConfigs", 2)
  if (CA_adapter != "caddyfile") why = why " caddyJson"
  if (CA_resume) why = why " caddyResume"
  if (CA_adminoff) why = why " adminOff"
  if (CA_autohttpsoff) why = why " autoHttpsOff"
  if (CA_version ~ /^1\./) why = why " caddy1"
  if (HK[443] == "container" && (CA_mount == "" || CA_hostpath == NUL)) why = why " caddyBaked"
  return substr(why, 2)
}
function helpernetwork(c,    j, best) {
  best = NUL
  for (j = 1; j <= C_netn[c]; j++)
    if (C_netuser[c, j] && C_netdrv[c, j] != "macvlan" && C_netdrv[c, j] != "ipvlan" && (best == NUL || C_netname[c, j] < best)) best = C_netname[c, j]
  return best
}
function byholders(    problems, c, net, j, mv, savedc, savedw) {
  if (HK[443] == "split" || HK[80] == "split") return manual("split")
  if (isours(443) || isours(80)) return manual("otherSetup")
  if (isfree(443)) return isfree(80) ? owncase("1", "server.case.1", NUL) : owncase("1b", "server.case.1b", holdername(80))
  if (!iscaddy(443)) return casefour(holdername(443))
  if (CADDY && inlist(W_DOMAIN, CA_host, CA_hostn)) return manual("domainServed")
  problems = caddyproblems()
  if (problems != "") {
    casefour("Caddy")
    return CHOICE != "" ? 1 : manual(problems)
  }
  if (HK[443] == "unit") {
    if ("runuser" in H_missing) return manual("os")
    return chose("2", "server.case.2", "unit", "", HU[443], "")
  }
  c = containerof(HI[443])
  if (!c) return manual("twoConfigs")
  if (C_host[c]) {
    if (!portsfree("8481")) return manual("portTaken")
    return chose("3b", "server.case.3b", "container", "", C_name[c], "")
  }
  net = helpernetwork(c)
  if (net != NUL) return chose("3a", "server.case.3a", "container", "network", C_name[c], net)
  mv = 0
  for (j = 1; j <= C_netn[c]; j++) if (C_netdrv[c, j] == "macvlan" || C_netdrv[c, j] == "ipvlan") mv = 1
  return manual(mv ? "macvlan" : "bridge")
}
# chooseCase: CHOICE (a case, or "" with WHY the reasons), RECORD (1: the board's own), WHO
function choose(    limits) {
  RECORD = 0; WHO = ""
  limits = hostlimits()
  if (limits != "") return manual(limits)
  if (REC_present) {
    RECORD = setup_record()
    if (!RECORD) return manual("otherSetup")
    if (holds_setup()) {
      WHO = whose()
      if (WHO == "other") return manual("otherSetup")
      if (REC_state == "running" && !LOCK_held) return manual("interrupted")
      return chose(REC_case, "server.case." WHO, "case", "domain", REC_case, REC_domain)
    }
  }
  return byholders()
}

# ---------------------------------------------------------------------------------------------
# What a plan is made of (core/server-plan.ts buildPlan's shapes, theirCaddy, fetchHosts, relies)

function hostname_ok(h,    l) { l = tolower(h); return l ~ /[a-z]/ && l ~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/ }
# their exact host names (no wildcard, no address, not the domain, nor MOVED: the one an update moves
# the board away from), each once, into OUT; how many
function exacthosts(A, n, domain, OUT,    i, m, seen) {
  m = 0
  for (i = 1; i <= n; i++) if (!((A[i]) in seen) && (seen[A[i]] = 1) && hostname_ok(A[i]) && A[i] != domain && (MOVED == "" || A[i] != MOVED)) OUT[++m] = A[i]
  return m
}
# the first of them, at most 20 and 1,500 characters
function fetchhosts(A, n, domain, OUT,    E, m, i, k, chars) {
  m = exacthosts(A, n, domain, E); k = 0; chars = 0
  for (i = 1; i <= m; i++) {
    if (k == 20 || chars + length(E[i]) > 1500) break
    OUT[++k] = E[i]; chars += length(E[i])
  }
  return k
}
# their Caddy as the plan's steps use it (theirCaddy): 0 when there is none to edit
function theircaddy(    ip, c, n, UA) {
  if (!CADDY || CA_hostpath == NUL) return 0
  TC_file = CA_hostpath
  if (!isline(TC_file) || !isplainpath(TC_file)) return 0
  ip = CA_address; if (ip ~ /^\[.*\]$/) ip = substr(ip, 2, length(ip) - 2)
  sub(/%[^%]*$/, "", ip)
  TC_address = (ip != "" && ip !~ /[^0-9A-Fa-f.:]/) ? ip : "127.0.0.1"
  if (!ishex64(CA_sha)) return 0
  TC_sha = CA_sha
  TC_fetch = H_fetch == "curl"
  if (CA_where == "unit") {
    TC_unit = 1
    n = unitargv("caddy.service", UA)
    TC_bin = (n > 0 && UA[0] != "" && isplainpath(UA[0])) ? UA[0] : "caddy"
    TC_user = (U_has["caddy.service"] && U_user["caddy.service"] != "") ? U_user["caddy.service"] : "root"
    TC_cand = 1
    return 1
  }
  if (!iscontainerid(CA_container) || !isline(CA_config)) return 0
  TC_unit = 0; TC_cid = CA_container
  TC_cand = (CA_mount == "folder" || CA_mount == "volume")
  return 1
}

# ---------------------------------------------------------------------------------------------
# Values for the templates: VAL[name], a list in VLIST[name, i] (VLN[name] of them)

function setv(name, v) { VAL[name] = v; if (!safe(v)) REFUSE = REFUSE " " name }
function setlist(name, A, n,    i) {
  VISLIST[name] = 1; VLN[name] = n
  for (i = 1; i <= n; i++) { VLIST[name, i] = A[i]; if (!safe(A[i])) REFUSE = REFUSE " " name }
}
function shownv(s,    i, c, out) {
  out = ""
  for (i = 1; i <= length(s); i++) { c = substr(s, i, 1); if (ORD[c] >= 32 && ORD[c] != 127) out = out c }
  return out
}
function setd(name, v) { VAL[name] = shownv(v) }
function printvalues(    name, i) {
  for (name in VAL) if (!(name in VISLIST)) {
    if (index(VAL[name], "\n")) { print "l " name; if (VAL[name] != "") print VAL[name]; print "@@ab-end-value" }
    else print "v " name " " VAL[name]
  }
  for (name in VISLIST) { print "e " name; for (i = 1; i <= VLN[name]; i++) print "w " name " " VLIST[name, i] }
}
function filltext(t,    out, k, rest, e, inner, name, sp, bar) {
  out = ""
  while ((k = index(t, "@{")) > 0) {
    rest = substr(t, k + 2); e = index(rest, "}@")
    if (!e) break
    inner = substr(rest, 1, e - 1)
    if (inner !~ /^[a-z0-9_]+([|][a-z]+)?$/) { out = out substr(t, 1, k + 1); t = rest; continue }
    bar = index(inner, "|"); name = bar ? substr(inner, 1, bar - 1) : inner; sp = bar ? substr(inner, bar + 1) : "id"
    out = out substr(t, 1, k - 1) spellv(name, sp)
    t = substr(rest, e + 2)
  }
  return out t
}
function spellv(name, sp,    i, s, item) {
  need(name)
  if (sp == "id") return VAL[name]
  if (sp == "q") return q(VAL[name])
  if (sp == "sqq") return sqq(VAL[name])
  s = ""
  for (i = 1; i <= VLN[name]; i++) {
    item = VLIST[name, i]
    if (sp == "sqwords") item = shquote(item)
    else if (sp == "qwords") item = q(item)
    else if (sp == "listen") item = q("    listen " item ";")
    else { MISSING = name "|" sp; return "" }
    s = s (i > 1 ? " " : "") item
  }
  return s
}
function need(name) { if (!((name in VAL) || (name in VISLIST))) MISSING = name }

# the guard's lines (core/server-plan.ts relyOn, relyLine), in RELIES
function relyon(p) {
  if (isours(p)) return
  if (HK[p] == "free") addrely("r.free." p ".d" (DOCKER ? 1 : 0), "")
  else if (HK[p] == "container") addrely("r.container." p, HI[p])
  else if (HK[p] == "unit" || HK[p] == "process") addrely("r.program." p "." HP[p], "")
}
function relyconfig() { addrely("r.config", "") }
function addrely(key, cid,    t, n, i, NAMES, had, was) {
  if (!(key in RELY)) { INTERNAL = INTERNAL " " key; return }
  # filled with its own values; the template's own stay as they were
  n = split("cid file sha", NAMES, " ")
  for (i = 1; i <= n; i++) { had[i] = (NAMES[i] in VAL); was[i] = VAL[NAMES[i]] }
  VAL["cid"] = cid; VAL["file"] = TC_file; VAL["sha"] = TC_sha
  t = filltext(RELY[key])
  for (i = 1; i <= n; i++) { if (had[i]) VAL[NAMES[i]] = was[i]; else delete VAL[NAMES[i]] }
  RELIES = RELIES (RELIES == "" ? "" : "\n") t
}

# FNV-1a, 64 bits, in hex (core/server-texts.ts argsHash), of the text's bytes
function xor8(a, b,    r, bit, k) {
  r = 0; bit = 1
  for (k = 0; k < 8; k++) { if (int(a / bit) % 2 != int(b / bit) % 2) r += bit; bit *= 2 }
  return r
}
function fnv(s,    H, T, U, i, j, m, carry, out) {
  split("37 35 34 132 228 156 242 203", H, " ")
  for (j = 1; j <= 8; j++) H[j] = H[j] + 0
  for (i = 1; i <= length(s); i++) {
    H[1] = xor8(H[1], ORD[substr(s, i, 1)])
    carry = 0
    for (j = 1; j <= 8; j++) { m = H[j] * 435 + carry; T[j] = m % 256; carry = int(m / 256) }
    carry = 0
    for (j = 1; j <= 8; j++) { m = T[j] + (j >= 6 ? H[j - 5] : 0) + carry; U[j] = m % 256; carry = int(m / 256) }
    for (j = 1; j <= 8; j++) H[j] = U[j]
  }
  out = ""
  for (j = 8; j >= 1; j--) out = out sprintf("%02x", H[j])
  return out
}

# ---------------------------------------------------------------------------------------------
# Texts (in the board's language)

# a text by its key, each {name} of the values given replaced once over (the board's translator)
function tx(key, n1, v1, n2, v2, n3, v3,    s, out, k, e, name) {
  s = (key in TXT) ? TXT[key] : key
  out = ""
  while ((k = index(s, "{")) > 0) {
    e = index(substr(s, k + 1), "}")
    name = e ? substr(s, k + 1, e - 1) : ""
    if (name ~ /^[A-Za-z0-9_]+$/ && (name == n1 || name == n2 || name == n3)) {
      out = out substr(s, 1, k - 1) shownv(name == n1 ? v1 : name == n2 ? v2 : v3)
      s = substr(s, k + e + 1)
    } else {
      out = out substr(s, 1, k)
      s = substr(s, k + 1)
    }
  }
  return out s
}
function saywhy(list,    n, W, i) {
  n = split(list, W, " ")
  for (i = 1; i <= n; i++) print "why " tx("server.manual." W[i])
}
function warn(key, n1, v1, n2, v2) { print "warn " tx("server.warn." key, n1, v1, n2, v2) }
function somehosts(A, n, domain,    E, F, all, k) {
  all = exacthosts(A, n, domain, E); k = fetchhosts(A, n, domain, F)
  if (k < all) warn("someHosts", "n", k, "all", all)
}
# the plan's warnings (core/server-plan.ts warningsFor)
function warnings(c, dockerstep, fetchstep,    i, j, found, list) {
  if (DNS_dn == 0) warn("noDns", "domain", W_DOMAIN)
  else {
    found = 0
    for (i = 1; i <= DNS_dn; i++) for (j = 1; j <= DNS_ln; j++) if (DNS_d[i] == DNS_l[j]) found = 1
    if (!found) {
      list = ""
      for (i = 1; i <= DNS_dn; i++) list = list (i > 1 ? ", " : "") DNS_d[i]
      warn("dns", "domain", W_DOMAIN, "addresses", list)
    }
  }
  if (dockerstep && (H_forwarding || H_forwarders != "")) warn("forwarding", "forwarders", H_forwarders != "" ? H_forwarders : "ip_forward")
  list = c == "1" ? "80, 443" : c == "1b" ? "443" : c == "4a" ? "80, 8443" : c == "4b" ? "8443" : ""
  if (list != "") warn("ports", "ports", list)
  if (c == "3a" || c == "3b") warn("tcpHop")
  if (c == "3a") warn("composeDown", "network", NETWORK)
  if ((c == "2" || c == "3a" || c == "3b" || c == "4b") && H_fetch != "curl") warn("noFetch")
  if (fetchstep) somehosts(CA_host, CA_hostn, W_DOMAIN)
  if (c == "4b" && H_fetch == "curl") somehosts(NX_n, NX_nn, W_DOMAIN)
  if (FOLDER && FO_members != "") warn("groupMembers", "group", FO_group, "members", FO_members)
  if (c == "2" && (!U_has["caddy.service"] || U_user["caddy.service"] == "" || U_user["caddy.service"] == "root")) warn("caddyRoot")
}

# ---------------------------------------------------------------------------------------------
# The plan in plain words (core/server-plain.ts plainPlan): "pfound", "pwill" lines, "pdocker",
# "puntouched", "pstop"

# who answers on a port, in a few words: Caddy, Caddy in Docker, nginx, the board's own, a program
function whoon(p,    c, img, name, k) {
  if (HK[p] == "free") return ""
  if (HK[p] == "split") return HS[p]
  if (HK[p] != "container") return HP[p] == "caddy" ? "Caddy" : HP[p]
  c = containerof(HI[p])
  if (c && C_label[c, ROLE_LABEL] != "") return tx("server.plain.who.board")
  img = c ? C_image[c] : ""
  if (HP[p] == "caddy" || img ~ /(^|\/)caddy([:@]|$)/) name = "Caddy"
  else {
    name = HP[p]
    if (c) {
      k = match(img, /[:@]/); name = k ? substr(img, 1, k - 1) : img
      name = substr(name, lastindex(name, "/") + 1)
    }
    if (name == "") name = HP[p]
  }
  return tx("server.plain.who.docker", "name", name)
}
# their sites: the names their Caddy (or else their nginx) serves, the board's domain apart
function sites(    A, n, i, E, m, list, seen) {
  n = 0
  if (CADDY && CA_hostn > 0) for (i = 1; i <= CA_hostn; i++) A[++n] = CA_host[i]
  else if (NGINX) for (i = 1; i <= NX_nn; i++) A[++n] = NX_n[i]
  m = 0
  for (i = 1; i <= n; i++) if (!(A[i] in seen) && (seen[A[i]] = 1) && hostname_ok(A[i]) && A[i] != W_DOMAIN) E[++m] = A[i]
  if (m == 0) return ""
  list = ""
  for (i = 1; i <= m && i <= 3; i++) list = list (i > 1 ? ", " : "") E[i]
  return m > 3 ? tx("server.plain.sitesMore", "sites", list, "more", m - 3) : tx("server.plain.sites", "sites", list)
}
function capitalize(s) { return toupper(substr(s, 1, 1)) substr(s, 2) }
# what was found: the system and what answers on 443 and 80, one line
function pfound(    name, sys, w443, w80, s, web) {
  name = trim(capitalize(DI_id) " " DI_version)
  sys = DI_supported ? name : tx("server.plain.unsupported", "system", name)
  w443 = whoon(443); w80 = whoon(80); s = sites()
  if (w443 == "" && w80 == "") web = tx("server.plain.web.none")
  else if (w443 == w80) web = tx("server.plain.web.both", "who", w443, "sites", s)
  else if (w80 == "") web = tx("server.plain.web.only443", "who", w443, "sites", s)
  else if (w443 == "") web = tx("server.plain.web.only80", "who", w80)
  else web = tx("server.plain.web.each", "who443", w443, "who80", w80, "sites", s)
  print "pfound " tx("server.plain.found", "system", sys, "web", web)
}
function stopkind(w) {
  if (w == "os") return "os"
  if (w == "selinux" || w == "podman" || w == "rootless" || w == "userns" || w == "requiretty" || w == "noSystemd" || w == "dockerConflicts") return "system"
  if (w == "domainServed" || w == "otherSetup" || w == "interrupted" || w == "folder" || w == "tunnelUser" || w == "tunnelGroup") return w
  return "web"
}
# the board does not do this server: why, in plain words and then each reason; the decision line
function stop(why,    W) {
  split(why, W, " ")
  print "pstop " tx("server.plain.stop", "reason", tx("server.plain.stop." stopkind(W[1] == "" ? "os" : W[1]), "domain", W_DOMAIN, "user", W_USER))
  print "puntouched " tx("server.plain.untouched.nothing")
  saywhy(why)
  print "stop " why
}
function hasstep(id,    k) { for (k = 1; k <= NS; k++) if (ST_id[k] == id) return 1; return 0 }
# what the steps ST 1..NS will do (kind: apply, update or undo), what they leave alone
function pplan(kind, c, address,    k, login, checked) {
  login = 0; checked = 0
  for (k = 1; k <= NS; k++) {
    if (ST_id[k] == "tunnel-user" || ST_id[k] == "socket-folder" || ST_id[k] == "sshd-fence" || ST_id[k] == "drop-user" || ST_id[k] == "drop-fence" || ST_id[k] == "drop-keys" || ST_id[k] == "drop-folder") login = 1
    if (ST_id[k] == "fetch-before" || ST_nb[k]) checked = 1
  }
  if (kind == "undo") {
    print "pwill " tx(login ? "server.plain.will.undoLogin" : "server.plain.will.undo", "domain", RECHOST, "user", W_USER)
    print "puntouched " tx(checked ? "server.plain.untouched.undoChecked" : "server.plain.untouched.undo")
    return
  }
  if (login) print "pwill " tx("server.plain.will.login", "user", W_USER)
  else if (hasstep("keys-file")) print "pwill " tx("server.plain.will.key", "user", W_USER)
  if (hasstep("keys-file") && S1 && S1_keys == "other") print "pwill " tx("server.plain.will.keysReplaced", "user", W_USER)
  print "pwill " tx(kind == "update" ? "server.plain.will.update" : "server.plain.will.case." c, "domain", W_DOMAIN, "address", address)
  if (hasstep("docker-install")) print "pdocker " tx("server.plain.docker")
  if (c == "1") print "puntouched " tx("server.plain.untouched.all")
  else if (c == "1b") print "puntouched " tx("server.plain.untouched.port", "who", whoon(80), "port", "80")
  else if (c == "4a") print "puntouched " tx("server.plain.untouched.port", "who", whoon(443), "port", "443")
  else print "puntouched " tx(checked ? "server.plain.untouched.sitesChecked" : "server.plain.untouched.sites")
}

# ---------------------------------------------------------------------------------------------
# The plan's steps, from the step templates (core/server-oneshot-templates.ts dictionary): ST_*[k]
# of step k, 1 the guard; the record's items as the run's variables I<n> (V_*[n]), the first
# CARRIED of them the guard's (the record's items carried over)

# a line of the templates: "@@t <name>" and its lines, or "@@shape <key> <name>…"
function dictline(l,    k) {
  if (startswith(l, "@@t ")) { DCUR = substr(l, 5); TPLN[DCUR] = 0; return }
  if (startswith(l, "@@shape ")) { l = substr(l, 9); k = index(l " ", " "); SHAPE[substr(l, 1, k - 1)] = substr(l, k + 1); return }
  if (DCUR != "") TPL[DCUR, ++TPLN[DCUR]] = l
}
# the guard: the rely lines (guardlines, once they are all said), nothing of its own on the record
# (core/server-plan.ts guard)
function addguard() {
  NS = 1
  ST_id[1] = "guard"; ST_to[1] = 60; ST_bh[1] = 0; ST_nb[1] = 0; ST_title[1] = tx("server.step.guard.title")
  ST_sn[1] = 0; ST_kn[1] = 0; ST_un[1] = 0; ST_rn[1] = 0
}
function guardlines(    n, L, i) {
  if (RELIES != "") { n = split(RELIES, L, "\n"); for (i = 1; i <= n; i++) ST_s[1, ++ST_sn[1]] = L[i] }
}
# the next step: a template by its name, filled in
function addstep(name,    k, i, l, n, tag, rest, P) {
  if (!(name in TPLN)) { INTERNAL = INTERNAL " " name; return }
  k = ++NS
  ST_sn[k] = 0; ST_kn[k] = 0; ST_un[k] = 0; ST_rn[k] = 0; ST_title[k] = ""
  for (i = 1; i <= TPLN[name]; i++) {
    l = filltext(TPL[name, i])
    n = index(l, " "); tag = n ? substr(l, 1, n - 1) : l; rest = n ? substr(l, n + 1) : ""
    if (tag == "@@step") { split(rest, P, " "); ST_id[k] = P[1]; ST_to[k] = P[2]; ST_bh[k] = P[3] + 0; ST_nb[k] = P[4] + 0 }
    else if (tag == "T") ST_title[k] = rest
    else if (tag == "S") ST_s[k, ++ST_sn[k]] = rest
    else if (tag == "K") ST_k[k, ++ST_kn[k]] = rest
    else if (tag == "U") ST_u[k, ++ST_un[k]] = rest
    else if (tag == "R") { n = ++ST_rn[k]; ST_rc[k, n] = substr(rest, 1, 1); ST_rk[k, n] = substr(rest, 3) }
    else if (tag == "W0") ST_w0[k, ST_rn[k]] = rest
    else if (tag == "W1") ST_w1[k, ST_rn[k]] = rest
    else if (tag == "WA") ST_wa[k, ST_rn[k]] = rest
  }
}
# the record's items the run carries over (DD's, as the board writes them), then each step's own (Apply)
function carryall(    i, k) {
  VN = 0
  for (i = 1; i <= DDN; i++) {
    k = DD[i]; VN++
    V_step[VN] = 1; V_kind[VN] = RI_kind[k]; V_key[VN] = itemkey(k); V_w0[VN] = shquote(itemjson(k))
  }
  CARRIED = VN
}
function stepvars(    k, j) {
  for (k = 2; k <= NS; k++) for (j = 1; j <= ST_rn[k]; j++) {
    VN++; V_step[VN] = k; V_cls[VN] = ST_rc[k, j]; V_key[VN] = ST_rk[k, j]
    V_w0[VN] = ST_w0[k, j]; V_w1[VN] = ST_w1[k, j]; V_wa[VN] = ST_wa[k, j]
  }
}
# the carried items step k names (its items' keys; "*": all of them, or all of a kind): "I<n> …"
function takenby(k,    n, j, out, hit) {
  out = ""
  for (n = 1; n <= CARRIED; n++) {
    hit = 0
    for (j = 1; j <= ST_rn[k] && !hit; j++)
      if (ST_rc[k, j] == "*") hit = ST_rk[k, j] == "all" || ST_rk[k, j] == V_kind[n]
      else hit = ST_rk[k, j] == V_key[n]
    if (hit) out = out " I" n
  }
  return substr(out, 2)
}
# the carried item with the key of variable n
function earlier(n,    m) { for (m = 1; m <= CARRIED; m++) if (V_key[m] == V_key[n]) return m; return 0 }

# ---------------------------------------------------------------------------------------------
# The run (core/server-script.ts runScript): the steps under the server's lock, the record written
# as they go, a failure rolled back newest first

function unchanged(why) { return "{ echo " shquote(why ": nothing was changed.") "; exit 3; }" }
# a step's text in a variable, verbatim: S its commands and check, K its skip checks, U its undo
function verbatim(k, part,    i, n) {
  print toupper(part) k "=$(cat <<'" STEP_END "'"
  n = part == "s" ? ST_sn[k] : part == "k" ? ST_kn[k] : ST_un[k]
  for (i = 1; i <= n; i++) print (part == "s" ? ST_s[k, i] : part == "k" ? ST_k[k, i] " || exit 1" : ST_u[k, i])
  print STEP_END
  print ")"
}
function assemble(undo, kase, domain, port, address,    k, n, m, i, line, head, mid, unrec, old, sup, SEEN, W, drop, bk, recording, set, cls, e, keep, ahead, off) {
  head = "{\"v\":1,\"id\":" jstr(RUN_ID) ",\"at\":" jstr(RUN_AT) ",\"state\":\""
  mid = "\"case\":" jstr(kase) ",\"pair\":{\"user\":" jstr(W_USER) ",\"socket\":" jstr(W_SOCKET) "},\"domain\":" jstr(domain) ",\"publicPort\":" (port == "" ? "null" : port) ",\"address\":" jstr(address) ",\"items\":["
  unrec = "echo " shquote("The record " RECORD_FILE " could not be written.")
  old = shquote(BOARD_DIR "/backups/" PLAN_ID "/setup.json")
  print "exec </dev/null"
  print "# agent-board: run"
  print "set -u"
  print "umask 077"
  print "sudo() { \"$@\"; }"
  print "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH"
  print "LC_ALL=C; export LC_ALL"
  print "trap 'echo \"$?\" > " RUNS_DIR "/" RUN_ID ".exit' EXIT"
  print "STOP=0"
  print "trap 'STOP=1' HUP INT TERM"
  print "exec 9>" LOCK_FILE
  print "flock -n 9 || { echo '@@busy'; exit 75; }"
  print "P='set -e"
  print "sudo() { \"$@\"; }"
  print "'"
  print "SKIP=false"
  if (VN) { line = ""; for (n = 1; n <= VN; n++) line = line (n > 1 ? " " : "") "I" n "=''"; print line }
  if (NS > 1) { line = ""; for (k = 2; k <= NS; k++) line = line (k > 2 ? " " : "") "D" k "=0"; print line }
  for (k = 1; k <= NS; k++) {
    if (ST_bh[k]) continue
    print "# " k ": " ST_id[k]
    verbatim(k, "s")
    if (ST_kn[k]) verbatim(k, "k")
    if (ST_un[k]) verbatim(k, "u")
  }
  # record(): written whole or not at all
  print "record() {"
  print "  it=''"
  if (VN) {
    line = "  for x in"
    for (n = 1; n <= VN; n++) line = line " \"$I" n "\""
    print line "; do if [ -n \"$x\" ]; then it=\"$it,$x\"; fi; done"
  }
  print "  printf '%s%s%s%s%s\\n' " shquote(head) " \"$1\" " shquote("\"," mid) " \"$" "{it#,}\" ']}' > " RECORD_FILE ".new &&"
  print "    [ \"$(tail -c 3 " RECORD_FILE ".new)\" = ']}' ] && chmod 644 " RECORD_FILE ".new && mv -f " RECORD_FILE ".new " RECORD_FILE
  print "}"
  print "run() {"
  print "  echo \"@@step $1 start\""
  print "  if [ -n \"$3\" ] && timeout -k 5 " SKIP_S " sh -c \"$P$3\" >/dev/null 2>&1 9>&-; then echo \"@@step $1 skip\"; SKIP=true; return 0; fi"
  print "  if timeout -k 5 \"$2\" sh -c \"$P$4\" 9>&-; then echo \"@@step $1 ok\"; SKIP=false; return 0; fi"
  print "  echo \"@@step $1 fail\""
  print "  return 1"
  print "}"
  print "undo() {"
  print "  if timeout -k 5 \"$2\" sh -c \"$P$3\" 9>&-; then echo \"@@undo $1 ok\"; return 0; fi"
  print "  echo \"@@undo $1 fail\""
  print "  return 1"
  print "}"
  # finish(): an Apply's carried items a step superseded come off the record
  sup = ""
  if (!undo) for (k = 2; k <= NS; k++) {
    m = split(takenby(k), W, " ")
    for (i = 1; i <= m; i++) if (!(W[i] in SEEN)) { SEEN[W[i]] = 1; sup = sup W[i] "=''; " }
  }
  print "finish() {"
  print "  case $1 in"
  print "  applied) " sup (undo ? "rm -f " RECORD_FILE : "record applied || { " unrec "; back; }") " ;;"
  if (undo) print "  rolled-back) record rolled-back || { " unrec "; set -- rollback-failed; } ;;"
  else print "  rolled-back) { if [ -f " old " ]; then cp -p " old " " RECORD_FILE ".new && mv -f " RECORD_FILE ".new " RECORD_FILE "; else record rolled-back; fi; } || { " unrec "; set -- rollback-failed; } ;;"
  print "  *) record \"$1\" || " unrec " ;;"
  print "  esac"
  print "  echo \"@@result $1\""
  print "  case $1 in applied) exit 0 ;; rolled-back) exit 1 ;; *) exit 2 ;; esac"
  print "}"
  # back(): newest first, a step that ran has its undo run; its items come off the record when that works
  print "back() {"
  print "  R=rolled-back"
  for (k = NS; k >= 2; k--) {
    drop = ""; bk = ""
    if (undo) {
      m = split(takenby(k), W, " ")
      for (i = 1; i <= m; i++) bk = bk (bk == "" ? "" : "; ") W[i] "=" V_w0[substr(W[i], 2) + 0]
    } else {
      for (n = CARRIED + 1; n <= VN; n++) if (V_step[n] == k && V_cls[n] != "d") drop = drop (drop == "" ? "" : "; ") "I" n "=''"
      bk = drop
    }
    if (ST_un[k]) print "  if [ \"$D" k "\" = 1 ]; then if undo " k " " ST_to[k] " \"$U" k "\"; then " (bk == "" ? "" : bk "; ") ":; else R=rollback-failed; fi; fi"
    else if (!undo && drop != "") print "  if [ \"$D" k "\" = 1 ]; then " drop "; fi"
  }
  print "  finish \"$R\""
  print "}"
  print "halt() {"
  print "  if [ \"$STOP\" = 1 ]; then echo " shquote("The run was told to stop: what it did is rolled back.") "; back; fi"
  print "}"
  # the guard: nothing done yet, nothing to roll back or record
  print "run 1 " ST_to[1] " '' \"$S1\" || exit 3"
  print "if [ \"$STOP\" = 1 ]; then exit 143; fi"
  print "if [ -f " RECORD_FILE " ]; then { install -d -m 700 " shquote(BOARD_DIR "/backups/" PLAN_ID) " && cp -p " RECORD_FILE " " old "; } || " unchanged("The record " RECORD_FILE " could not be copied") "; fi"
  for (n = 1; n <= CARRIED; n++) print "I" n "=" V_w0[n]
  print "record running || " unchanged("The record " RECORD_FILE " could not be written")
  recording = 1
  for (k = 2; k <= NS; k++) {
    if (recording) print "halt"
    if (ST_bh[k]) { print "echo '@@step " k " start'; echo '@@step " k " skip'"; continue }
    if (!undo) {
      # what the step will change, on the record before it runs
      ahead = ""; off = ""
      for (n = CARRIED + 1; n <= VN; n++) if (V_step[n] == k && V_cls[n] != "g" && V_cls[n] != "d") {
        ahead = ahead (ahead == "" ? "" : "; ") "I" n "=" V_wa[n]
        off = off (off == "" ? "" : "; ") "I" n "=''"
      }
      if (ahead != "") { print ahead; print "record running || { " off "; back; }" }
    }
    print "D" k "=1; run " k " " ST_to[k] " " (ST_kn[k] ? "\"$K" k "\"" : "''") " \"$S" k "\" || back"
    print "if [ \"$SKIP\" = true ]; then D" k "=0; fi"
    if (undo) {
      m = split(takenby(k), W, " ")
      line = ""
      for (i = 1; i <= m; i++) line = line (i > 1 ? "; " : "") W[i] "=''"
      if (line != "") print line
    } else for (n = CARRIED + 1; n <= VN; n++) {
      if (V_step[n] != k) continue
      set = "I" n "=" V_w1[n]; cls = V_cls[n]
      # a step that skips because an earlier run of the board did its work keeps that run's item
      e = (cls == "i" || cls == "g" || cls == "d" || cls == "m") ? earlier(n) : 0
      keep = e ? "elif [ -n \"$I" e "\" ]; then I" n "=$I" e "; " : ""
      if (cls == "g" || cls == "d") print "if [ \"$SKIP\" = false ]; then " set "; " keep "fi"
      else if (cls == "m") print "if [ \"$SKIP\" = false ]; then " set "; " keep "else I" n "=''; fi"
      else if (e) print "if [ \"$SKIP\" = false ]; then " set "; " keep "else " set "; fi"
      else print set
    }
    # Undo's last steps take the record away with the rest of the board's files
    if (undo && ST_id[k] == "forget") recording = 0
    if (recording) print "record running || back"
  }
  if (recording) print "halt"
  print "finish applied"
  print LAST_LINE
}

# ---------------------------------------------------------------------------------------------
# The modes

function main_r2(    key, adapt) {
  if (!round_one()) { print "unreadable"; return }
  caddy_target(); nginx_target()
  if (TG_where == "" && !NT) { print "r2 none"; return }
  adapt = TG_where != "" && TG_config != "" && TG_adapter == "caddyfile" && !TG_resume
  key = "l." (TG_where == "" ? "none" : TG_where) ".a" (adapt ? 1 : 0) ".h" (TG_where != "" && TG_hostpath != NUL ? 1 : 0) ".n" (NT ? (NT_conf != "" ? "conf" : "plain") : "none")
  if (TG_where == "unit") {
    setv("cr_bin", TG_bin)
    if (TG_hostpath != NUL) setv("cr_cfg", TG_hostpath)
    else if (adapt) setv("cr_rel", TG_config)
  }
  if (TG_where == "container") {
    setv("cr_cid", TG_container); setv("cr_cmd0", TG_cmd0)
    if (adapt) setv("cr_cfg", TG_config)
    if (TG_hostpath != NUL) setv("cr_host", TG_hostpath)
  }
  if (NT) { setv("nx_bin", NT_bin); if (NT_conf != "") setv("nx_conf", NT_conf) }
  if (REFUSE != "") { print "refuse" REFUSE; return }
  print "r2 " key
  printvalues()
}
function own(c) { return c == "1" || c == "1b" || c == "4a" || c == "4b" }
# the addresses of nginx's own port-80 listen lines, as the board's nginx file has them (core/server-texts.ts nginxFile)
function nginxlisten(OUT,    i, F, nf, a, n, seen) {
  n = 0
  for (i = 1; i <= NX_ln; i++) {
    nf = fields(NX_l[i], F); a = nf >= 1 ? F[1] : ""
    if (a ~ /^[][A-Za-z0-9_.:*-]+$/ && !(a in seen)) { seen[a] = 1; OUT[++n] = a }
  }
  if (!n) OUT[++n] = "80"
  return n
}
# where 4b fetches through nginx on 80 (core/server-plan.ts nginxAddress)
function nginxaddress(    i, F, nf, a, ip, any6) {
  if (NX_ln == 0) return "127.0.0.1"
  any6 = 0
  for (i = 1; i <= NX_ln; i++) {
    nf = fields(NX_l[i], F); a = nf >= 1 ? F[1] : ""
    if (a ~ /^[0-9]+$/ || a ~ /^\*:[0-9]+$/ || a ~ /^0\.0\.0\.0:[0-9]+$/) return "127.0.0.1"
    if (startswith(a, "[::]")) any6 = 1
  }
  if (any6) return "::1"
  nf = fields(NX_l[1], F); ip = nf >= 1 ? F[1] : ""
  sub(/:[0-9]+$/, "", ip); sub(/^\[/, "", ip); sub(/\]$/, "", ip)
  return (ip != "" && ip !~ /[^0-9a-fA-F.:]/) ? ip : "127.0.0.1"
}
# what went wrong putting the plan together, if anything (said, and 1)
function broken() {
  if (INTERNAL != "") { print "internal" INTERNAL; return 1 }
  if (MISSING != "") { print "internal " MISSING; return 1 }
  if (REFUSE != "") { print "refuse" REFUSE; return 1 }
  return 0
}
function titles(    k) { for (k = 1; k <= NS; k++) print "title " ST_title[k] }
function main_apply(    c, mine, old, who, docker, fetch, group, cand, update, rgid, key, HH, NH, nh, L, n, ug, was, asroot, cc, S, i, address) {
  if (!round_one()) { print "unreadable"; return }
  caddy_target(); nginx_target()
  if (!round_two()) { print "unreadable"; return }
  pfound()
  choose()
  if (CHOICE == "") {
    if (WHY == "interrupted" && RECORD) { print "interrupted"; return }
    stop(WHY); return
  }
  c = CHOICE
  mine = RECORD && whose() != "other"
  old = mine && holds_setup()
  who = old ? whose() : ""
  if (c == "2" || c == "3a" || c == "3b") {
    if (!theircaddy()) { stop("twoConfigs"); return }
    if (c == "2" && HK[443] != "unit") { stop("twoConfigs"); return }
    if (c != "2") {
      cc = containerof(CA_container)
      NETWORK = (c == "3a" && cc) ? helpernetwork(cc) : NUL
      if (c == "3a" && NETWORK == NUL) { stop("bridge"); return }
    }
  }
  if (c == "4b" && !NGINX) { stop("other80"); return }
  if (who == "same" || who == "update") {
    if (REC_state == "running" && LOCK_held) { print "busy"; return }
    if (REC_state != "applied") { print "unfinished " REC_state; return }
    # set up already: said so, unless step 1 lacks a part, which the plan makes again
    if (who == "same" && !NEED_user && !NEED_folder && NEED_keys == "" && !NEED_fence) { print "same " REC_address; return }
  }
  if (mine) dedupe(); else DDN = 0
  update = who == "update"
  if (update) MOVED = REC_domain
  # the run reads the gid of the socket's folder it makes (the cases with a container of the board's)
  rgid = NEED_folder && c != "2"
  docker = own(c) ? DOCKER : 1
  fetch = 0; group = 0; cand = 0
  # step 1's parts still missing come first in the guard (core/server-plan.ts stepOneSteps)
  if (NEED_user) addrely("r.none.user", "")
  if (NEED_folder) addrely("r.none.folder", "")
  if (NEED_keys == "make") addrely("r.none.keys", "")
  if (c == "4b" && H_fetch == "curl") { nh = fetchhosts(NX_n, NX_nn, W_DOMAIN, NH); fetch = nh > 0; if (fetch) setlist("nhosts", NH, nh) }
  if (c == "2" || c == "3a" || c == "3b") {
    nh = fetchhosts(CA_host, CA_hostn, W_DOMAIN, HH)
    fetch = TC_fetch && nh > 0
    if (fetch) setlist("hosts", HH, nh)
    setv("file", TC_file); setv("candidate", dirof(TC_file) "/.Caddyfile.agent-board"); setv("sha", TC_sha)
    setv("addr_r", resolveat(TC_address))
  }
  if (c == "2") {
    ug = U_group["caddy.service"] != "" ? U_group["caddy.service"] : U_user["caddy.service"]
    asroot = !U_has["caddy.service"] || U_user["caddy.service"] == "" || U_user["caddy.service"] == "root"
    # the folder's group: Look's, or the tunnel user's own when the run makes the folder
    was = FOLDER ? FO_group : NEED_folder ? (S1_group != "" ? S1_group : W_USER) : ""
    group = !asroot && was != "" && ug != "" && was != ug
    setv("bin", TC_bin); setv("user", TC_user)
    if (group) { setv("group", ug); setv("oldgroup", was) }
    relyon(443); relyconfig()
  }
  if (c == "3a" || c == "3b") {
    cand = TC_cand
    setv("cid", TC_cid); setv("config", CA_config); setv("config_candidate", dirof(CA_config) "/.Caddyfile.agent-board")
    if (c == "3a") setv("network", NETWORK)
    setv("socat_hash", fnv(filltext(HASH["h.socat." (c == "3b" ? "host" : "net")])))
    relyon(443); addrely("r.container.none", TC_cid); relyconfig()
    if (c == "3b") relyon(8481)
  }
  if (own(c)) {
    setv("docker_repo", "https://download.docker.com/linux/" (DI_id == "ubuntu" ? "ubuntu" : "debian"))
    if (c == "1" || c == "4a") relyon(80)
    if (c == "1" || c == "1b") relyon(443)
    if (c == "4a" || c == "4b") relyon(8443)
    if (c == "4b") {
      relyon(80); relyon(8480)
      n = nginxlisten(L); setlist("listen", L, n)
      setv("nginx_resolve", W_DOMAIN ":80:" resolveat(nginxaddress()))
    }
  }
  if (update) setv("old", REC_domain)
  if (FOLDER) setv("gid", FO_gid)
  setv("plan_id", PLAN_ID); setv("run_id", RUN_ID)
  key = "a." c ".d" docker ".f" fetch ".g" group ".c" cand ".u" update ".r" rgid
  if (!(key in SHAPE)) { print "internal " key; return }
  addguard(); guardlines()
  if (NEED_user) addstep("x.user")
  if (NEED_folder) addstep("x.folder")
  if (NEED_keys == "make") addstep(S1_keysdir ? "x.keys.make" : "x.keys.makedir")
  if (NEED_keys == "write") addstep("x.keys.write")
  if (NEED_fence) addstep(S1_include ? "x.fence.file" : "x.fence.block")
  n = split(SHAPE[key], S, " ")
  for (i = 1; i <= n; i++) addstep(S[i])
  if (broken()) return
  address = caseaddress(c)
  warnings(c, hasstep("docker-install"), hasstep("fetch-before"))
  pplan(update ? "update" : "apply", c, address)
  print "plan " key
  print "address " address
  titles()
  carryall(); stepvars()
  print "@@ab-run"
  assemble(0, c, W_DOMAIN, c == "4a" || c == "4b" ? 8443 : "", address)
}
# Undo names their Caddyfile's line or block even when the record does not (core/server-plan.ts withEdit)
function withedit(    kind, i, k, file) {
  kind = REC_case == "2" ? "line" : (REC_case == "3a" || REC_case == "3b") ? "block" : ""
  if (kind == "") return
  for (i = 1; i <= DDN; i++) if (RI_kind[DD[i]] == kind) return
  file = NUL
  for (i = 1; i <= DDN; i++) if (RI_kind[DD[i]] == "backup") { file = RI_of[DD[i]]; break }
  if (file == NUL && theircaddy()) file = TC_file
  if (file == NUL || !isplainpath(file)) return
  k = ++REC_n; RI_kind[k] = kind; RI_file[k] = file; DD[++DDN] = k
}
# Undo's steps for one item of the record, or its volumes, or the images the board pulled
# (core/server-oneshot-templates.ts undoParts): a part's templates by its name, filled in
function undopart(key,    n, S, i) {
  if (!(key in SHAPE)) { if (UNKNOWN == "") UNKNOWN = key; return }
  n = split(SHAPE[key], S, " ")
  for (i = 1; i <= n; i++) addstep(S[i])
}
# their Caddyfile's line or block taken out, by what Look finds of their Caddy now (theirs: the
# guard relies on it as it is)
function undoedit(k, tc,    theirs, cand, fetch, nh, HH) {
  setv("ufile", RI_file[k]); setv("ufile_candidate", dirof(RI_file[k]) "/.Caddyfile.agent-board")
  theirs = "none"; cand = 0; fetch = 0
  if (tc && TC_file == RI_file[k]) {
    theirs = CA_where
    cand = CA_where == "container" && TC_cand
    nh = fetchhosts(CA_host, CA_hostn, REC_domain, HH)
    fetch = TC_fetch && nh > 0
    if (fetch) setlist("hosts", HH, nh)
    setv("sha", TC_sha); setv("addr_r", resolveat(TC_address))
    if (CA_where == "unit") { setv("bin", TC_bin); setv("user", TC_user) }
    else { setv("cid", TC_cid); setv("config", CA_config); setv("config_candidate", dirof(CA_config) "/.Caddyfile.agent-board") }
    relyconfig(); relyon(443)
  } else if (tc) { theirs = "other"; setv("tfile", TC_file) }
  undopart("u." (RI_kind[k] == "line" ? "L" : "B") ".t" theirs ".c" cand ".f" fetch)
}
# a file of the board's: Caddy's, nginx's (its sites fetched around it), or the site file, which
# stays while a Caddyfile imports it (the record's lines' files, their Caddy's)
function undofile(k, tc,    nh, NH, n, i, IMP, seen) {
  if (RI_path[k] == CADDY_FILE) { setv("sha_caddyfile", RI_sha[k]); undopart("u.F1"); return }
  if (RI_path[k] == NGINX_FILE) {
    setv("sha_nginx", RI_sha[k])
    nh = H_fetch == "curl" ? fetchhosts(NX_n, NX_nn, REC_domain, NH) : 0
    if (nh) setlist("nhosts", NH, nh)
    undopart("u.F3.n" (nh > 0 ? 1 : 0)); return
  }
  setv("sha_site", RI_sha[k])
  n = 0
  for (i = 1; i <= DDN; i++) if (RI_kind[DD[i]] == "line" && !(RI_file[DD[i]] in seen)) { seen[RI_file[DD[i]]] = 1; IMP[++n] = RI_file[DD[i]] }
  if (tc && !(TC_file in seen)) IMP[++n] = TC_file
  if (n) setlist("importers", IMP, n)
  undopart("u.F2.i" (n ? 1 : 0))
}
# the record's volumes in one step, in its order
function undovolumes(    i, codes) {
  codes = ""
  for (i = 1; i <= DDN; i++) if (RI_kind[DD[i]] == "volume") codes = codes (RI_name[DD[i]] == VOLUME1 ? "V1" : "V2")
  undopart("u.V." codes)
}
# the images the board pulled in one step (none: no step), in the record's order
function undoimages(    i, n) {
  n = 0
  for (i = 1; i <= DDN; i++) if (RI_kind[DD[i]] == "image" && !RI_before[DD[i]]) setv("img" (++n), RI_ref[DD[i]])
  if (n) undopart("u.I." n)
}
function main_undo(    i, j, k, kind, tc, n, KN, made, done) {
  if (!round_one()) { print "unreadable"; return }
  caddy_target(); nginx_target()
  if (!round_two()) { print "unreadable"; return }
  pfound()
  if (!REC_present) { print "nothing"; return }
  if (!setup_record() || whose() == "other") { stop("otherSetup"); return }
  if (REC_state == "running" && LOCK_held) { print "busy"; return }
  dedupe(); withedit()
  tc = theircaddy()
  setv("rec_domain", REC_domain)
  k = REC_address; sub(/^[a-z]+:\/\//, "", k); sub(/[:\/].*$/, "", k); RECHOST = k
  setv("plan_id", PLAN_ID); setv("run_id", RUN_ID)
  # the guard first, its lines once the items' parts have said what they rely on
  addguard()
  # the record's items newest first, each its own steps (core/server-plan.ts undoPlan); step 1's
  # parts after them all
  for (i = DDN; i >= 1; i--) {
    k = DD[i]; kind = RI_kind[k]
    if (kind == "line" || kind == "block") undoedit(k, tc)
    else if (kind == "file") undofile(k, tc)
    else if (kind == "container") undopart(RI_name[k] == CADDY_NAME ? "u.K1" : "u.K2")
    else if (kind == "group") { setv("group_from", RI_from[k]); setv("group_to", RI_to[k]); undopart("u.G") }
    else if ((kind == "volume" || kind == "image") && !(kind in done)) {
      done[kind] = 1
      if (kind == "volume") undovolumes(); else undoimages()
    }
  }
  guardlines()
  # step 1's parts the board made, after the case's: the keys file, the fence, the folder, the user
  split("keys fence folder user", KN, " ")
  for (j = 1; j <= 4; j++) for (i = DDN; i >= 1; i--) {
    k = DD[i]
    if (RI_kind[k] != KN[j]) continue
    made[KN[j]] = 1
    if (KN[j] == "fence") addstep(RI_path[k] == SSHD_CONFIG ? "y.fence.block" : "y.fence.file")
    else if (KN[j] == "keys") addstep(RI_dir[k] ? "y.keys.dir" : "y.keys")
    else addstep("y." KN[j])
  }
  addstep("y.forget")
  # what was there before the board made anything of step 1 is the owner's to remove
  if (!(("fence" in made) && ("keys" in made) && ("folder" in made) && ("user" in made))) addstep("y.byhand")
  if (UNKNOWN != "") { print "unknown " UNKNOWN; return }
  if (broken()) return
  pplan("undo")
  print "plan undo"
  print "address " REC_address
  titles()
  carryall()
  print "@@ab-run"
  assemble(1, REC_case, RECHOST, REC_port, REC_address)
}

# a template filled in: the values, "@@ab-template", its lines
function bindline(l,    name, k, n) {
  if (!intemplate) {
    if (inmulti != "") {
      if (l == "@@ab-end-value") { VAL[inmulti] = MV; inmulti = "" }
      else { MV = MV (MVN++ ? "\n" : "") l }
      return
    }
    if (l == "@@ab-template") { intemplate = 1; return }
    if (startswith(l, "v ")) {
      name = substr(l, 3); k = index(name, " ")
      if (k) VAL[substr(name, 1, k - 1)] = substr(name, k + 1); else VAL[name] = ""
      return
    }
    if (startswith(l, "e ")) { name = substr(l, 3); VISLIST[name] = 1; VLN[name] = 0; return }
    if (startswith(l, "w ")) {
      name = substr(l, 3); k = index(name, " "); n = substr(name, 1, k - 1)
      VISLIST[n] = 1; VLIST[n, ++VLN[n]] = substr(name, k + 1)
      return
    }
    if (startswith(l, "l ")) { inmulti = substr(l, 3); MV = ""; MVN = 0; return }
    return
  }
  if (l ~ /^@[{][a-z0-9_]+[|]lines[}]@$/) {
    name = substr(l, 3, length(l) - 10); need(name)
    if (MISSING == "" && VAL[name] != "") print VAL[name]
  } else {
    l = filltext(l)
    if (MISSING == "") print l
  }
  if (MISSING != "") { print "agent-board: no value for " MISSING > "/dev/stderr"; BINDERR = 1; exit 2 }
}

# a run's lines as the owner reads them: each step once it ends, a failed step with its output
function progressline(l,    P, n, st, k) {
  if (l ~ /^@@step [0-9]+ (start|ok|fail|skip)$/) {
    split(l, P, " "); n = P[2] + 0; st = P[3]
    if (st == "start") { CUR = n; OUTN[n] = 0; return }
    if (st == "ok") print "  [ok] " title(n)
    else if (st == "skip") print "  [--] " title(n) " (" tx(title(n) == tx("server.step.by-hand.title") ? "server.oneshot.byHand" : "server.oneshot.inPlace") ")"
    else {
      print "  [!!] " title(n); FAILED = n
      for (k = 1; k <= OUTN[n]; k++) print "       " OUTL[n, k]
    }
    return
  }
  if (l ~ /^@@undo [0-9]+ (ok|fail)$/) {
    split(l, P, " ")
    print "  " (P[3] == "ok" ? tx("server.oneshot.undid") : tx("server.oneshot.undoFailed")) ": " title(P[2] + 0)
    return
  }
  if (l ~ /^@@result /) { RESULT = substr(l, 10); return }
  if (l ~ /^@@exit -?[0-9]+$/) { EXITC = substr(l, 8) + 0; return }
  if (l == "@@busy") { RESULT = "busy"; return }
  if (startswith(l, "@@changed")) { RESULT = "changed"; return }
  if (startswith(l, "@@")) return
  if (FAILED) { print "       " l; return }
  if (CUR) {
    OUTL[CUR, ++OUTN[CUR]] = l
    if (OUTN[CUR] > 40) { for (k = 1; k < 40; k++) OUTL[CUR, k] = OUTL[CUR, k + 1]; OUTN[CUR] = 40 }
  }
}
function title(n) {
  if (!TITLES_READ) { TITLEN = split(ENVIRON["AB_TITLES"], TITLE, "\n"); TITLES_READ = 1 }
  return (n >= 1 && n <= TITLEN) ? TITLE[n] : ("step " n)
}

{
  gsub(/\r/, "")
  if (mode == "bind") { bindline($0); next }
  if (mode == "progress") { progressline($0); next }
  # the step templates, before Look's output
  if (NR == 1 && $0 == "@@ab-dict") { part = 0; next }
  if (part == 0) { if ($0 == "@@ab-round1") part = 1; else dictline($0); next }
  if ($0 == "@@ab-round2") { part = 2; next }
  if (part == 1) R1[++N1] = $0
  else R2[++N2] = $0
}
END {
  if (mode == "r2") main_r2()
  else if (mode == "apply") main_apply()
  else if (mode == "undo") main_undo()
  else if (mode == "bind") { if (BINDERR) exit 2; if (!intemplate) exit 3 }
  else if (mode == "progress") {
    if (RESULT == "applied") exit 0
    if (RESULT == "rolled-back") exit 1
    if (RESULT == "rollback-failed") exit 2
    if (RESULT == "busy") exit 3
    if (RESULT == "changed") exit 4
    exit 5
  }
}
`
