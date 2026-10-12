# Security

## Reporting

Report vulnerabilities privately through GitHub's "Report a vulnerability" form on this repository
(Security tab) rather than in a public issue. You will get an acknowledgement within a few days.

## Threat model

witty sits between a terminal and a child program and interprets a graphics protocol in the child's
output. The child's output is treated as **untrusted**: Claude Code relays tool results, file
contents and model output, any of which can carry crafted escape sequences, so a hostile kitty
command can reach witty without the user doing anything unusual. The terminal's input (pasted text)
is untrusted too. The user running witty is the trust boundary.

What witty guarantees:

- The child's output can make witty draw pictures and nothing else. The only bytes witty ever
  writes on its own are sixel data and cursor movements built from numbers it computed, and the
  protocol's fixed-format responses to the child.
- Responses to the child never carry the child's own bytes back: status text is fixed strings,
  sanitised to printable ASCII, and ids are validated integers.
- File transport (`t=f`, `t=t`) reads only absolute, local, regular files, never UNC paths, device
  names, pipes, symlinks or directories; checks the size before reading; times out; reports every
  failure, including a file that reads but does not decode, with one identical status so nothing
  about the file system leaks; and deletes a temp file
  only inside the OS temp directory under kitty's naming rule. `--no-files` turns it off entirely.
- Memory and CPU are bounded: payloads, decoded images, the image store (bytes and image count),
  virtual placements, placement boxes, scaling scratch memory, held bytes and caches all have caps,
  zlib and PNG decoding are capped before decompression, and a placement draws at most a screenful.
- Nothing is run from the current directory: the child command and the portable launcher's
  `node.exe` are found on `PATH` only, and `cmd.exe` by absolute path. Arguments to a `.cmd`/`.bat`
  child (npm's `claude.cmd`) are quoted so cmd.exe cannot run any part of them as a command;
  arguments holding CR, LF or NUL are refused for batch children.
- The pseudo-console is Microsoft's own: node-pty's bundled `conpty.dll` and `OpenConsole.exe` are
  Authenticode-signed by Microsoft Corporation.

What witty does not protect against:

- Everything that is not a kitty graphics command passes through unchanged in both directions, as
  it would without witty. Terminal-level attacks that work without witty work with it.
- The `--log` file records witty's arguments, which include the child's arguments. Do not pass
  secrets on the command line if you log.
- `--wire <module>` loads a JavaScript module by path. It exists for tests; anyone who can set
  witty's arguments can run code as you anyway.

## Supply chain

Dependencies are pinned in `package-lock.json` with integrity hashes. Install with `npm ci`.
`npm audit` is clean at the time of writing. Dependabot watches npm and GitHub Actions. Workflow actions are pinned to
commit SHAs.
