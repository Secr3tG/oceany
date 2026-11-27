#!/usr/bin/env python3
"""Publish freshly built globe layers to Cloudflare R2 (or to a local folder, for testing) and update data/latest.json.

Run after the layer's build script, from the repo root:
    python3 scripts/publish_layers.py ocean snow --dest r2              (needs the aws CLI and the R2_* variables below)
    python3 scripts/publish_layers.py ocean --dest /some/folder          (test: same layout, written to a folder)
    --extra '<json>'   per-layer fields from scripts/layer_due.py (the source file's Last-Modified time)
    --max-bucket-gb N  measure the bucket first and upload nothing if it would end above N GB (the 10 GB free tier
                       minus the 1 GB margin: 9). Lists every object, so the workflow passes it on manual runs only.

Layout in the bucket (the globe reads it through pieces/07-globe/data-source.js):
    data/latest.json                       short cache; per layer: base folder, files, data time, model run, built-at time
    data/<layer>/<stamp>/<file>            long cache, never rewritten (stamp = build time, UTC, e.g. 20261123T041230Z)
The data files go up first and latest.json last, so a page never sees a half-written layer. A layer whose binary files are
byte-identical to the published ones is left alone (no new folder). Old folders are pruned, newest KEEP kept.
Nothing is committed to git.

R2 access (GitHub repo secrets, passed in as environment variables by the workflow):
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY        bucket: R2_BUCKET (default oceany-layers)
"""
import datetime, hashlib, json, os, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEEP = 4
LONG_CACHE = "public, max-age=31536000, immutable"
SHORT_CACHE = "public, max-age=60"

def iso(s):
    """Normalise the builders' time strings to ISO 8601 UTC ('2026-11-22 00 UTC' -> '2026-11-22T00:00:00Z')."""
    if not s: return None
    s = str(s).strip()
    try:
        if s.endswith(" UTC"):
            return datetime.datetime.strptime(s, "%Y-%m-%d %H UTC").strftime("%Y-%m-%dT%H:%M:%SZ")
        if len(s) == 10:
            return s + "T00:00:00Z"
        d = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        if d.tzinfo is None: d = d.replace(tzinfo=datetime.timezone.utc)
        return d.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return s

# Each layer: its data folder, the files the globe fetches, and how to read its times from its own JSON.
LAYERS = {
    # ocean: plus one wind and one wave file per forecast hour, as listed in ocean.json's steps
    "ocean": dict(dir="pieces/11-ocean/data", files=["ocean.json", "wind_gfs.bin", "waves_ww3.bin"],
                  more=lambda j: [f for s in j.get("steps") or [] for f in (s["wind"], s["waves"])],
                  times=lambda j: dict(dataTime=iso(j.get("valid")), modelRun=iso((j.get("wind") or {}).get("run")),
                                       builtAt=iso(j.get("built")),
                                       stepsFrom=iso(((j.get("steps") or [{}])[0]).get("valid")),
                                       stepsTo=iso(((j.get("steps") or [{}])[-1]).get("valid")))),
    # ecmwf: ECMWF IFS wind + waves (build_ecmwf.py), one file pair per 3-hourly step, as listed in ocean_ecmwf.json's steps
    "ecmwf": dict(dir="pieces/11-ocean/data", files=["ocean_ecmwf.json", "wind_ifs.bin", "waves_ifs.bin"],
                  more=lambda j: [f for s in j.get("steps") or [] for f in (s["wind"], s["waves"])],
                  times=lambda j: dict(dataTime=iso(j.get("valid")), modelRun=iso((j.get("wind") or {}).get("run")),
                                       builtAt=iso(j.get("built")),
                                       stepsFrom=iso(((j.get("steps") or [{}])[0]).get("valid")),
                                       stepsTo=iso(((j.get("steps") or [{}])[-1]).get("valid")))),
    "snow": dict(dir="pieces/10-sky/data", files=["snow_ims24.json", "snow_ims24.bin"],
                 times=lambda j: dict(dataTime=iso(j.get("valid")), builtAt=iso(j.get("built")))),
    "hurricanes": dict(dir="pieces/08-storms/data", files=["tracks.json", "tracks.bin", "density_points.bin", "track_radii.bin"],
                       times=lambda j: dict(dataTime=iso((j.get("meta") or {}).get("accessed")))),
    "tornadoes": dict(dir="pieces/08-storms/data", files=["tornado_tracks.json", "tornado_tracks.bin", "tornado_density_points.bin"],
                      times=lambda j: dict(dataTime=iso(j.get("fileLastModified")))),
    # hurricanes-live: one small JSON (build_hurricanes_live.py). Its "unchanged" test hashes the storms themselves, not the
    # build times, so a run that finds the same advisories uploads nothing. nhcStorms tells layer_due.py to check hourly.
    "hurricanes-live": dict(dir="pieces/08-storms/data", files=["live_storms.json"],
                            hash=lambda j: json.dumps([j.get("storms"), j.get("recent")], sort_keys=True).encode(),
                            times=lambda j: dict(dataTime=iso(j.get("dataTime")), builtAt=iso(j.get("built")),
                                                 nhcStorms=len(j.get("storms") or []), otherStorms=len(j.get("recent") or []))),
    # wavefc-gfs / wavefc-ecmwf: the wave forecast for the time bar (build_forecast.py), 0 to +168 h, 49 steps; about
    # 37 MB (GFS) and 33 MB (ECMWF) a run, 10 m wind included. keep=2: the run shown and the one before (pages still open on it keep
    # working), so the bucket holds about 140 MB for both, whatever the number of runs.
    "wavefc-gfs": dict(dir="pieces/11-ocean/data/forecast/gfs", files=["manifest.json", "mask_hi.bin.gz", "mask_lo.bin.gz"],
                       more=lambda j: [s[r] for s in j.get("steps") or [] for r in ("hi", "lo", "whi", "wlo") if s.get(r)], keep=2,
                       times=lambda j: dict(modelRun=iso(j.get("run")), builtAt=iso(j.get("built")),
                                            dataTime=iso(j.get("run")),
                                            stepsFrom=iso(((j.get("steps") or [{}])[0]).get("valid")),
                                            stepsTo=iso(((j.get("steps") or [{}])[-1]).get("valid")))),
    "wavefc-ecmwf": dict(dir="pieces/11-ocean/data/forecast/ecmwf", files=["manifest.json", "mask_hi.bin.gz", "mask_lo.bin.gz"],
                         more=lambda j: [s[r] for s in j.get("steps") or [] for r in ("hi", "lo", "whi", "wlo") if s.get(r)], keep=2,
                         times=lambda j: dict(modelRun=iso(j.get("run")), builtAt=iso(j.get("built")),
                                              dataTime=iso(j.get("run")),
                                              stepsFrom=iso(((j.get("steps") or [{}])[0]).get("valid")),
                                              stepsTo=iso(((j.get("steps") or [{}])[-1]).get("valid")))),
    "quakes": dict(dir="pieces/12-quakes/data", files=["quakes_m5.json", "quakes_m5.bin"],
                   times=lambda j: dict(dataTime=iso(j.get("lastEvent")), builtAt=iso(j.get("built")))),
}

class ReadError(Exception):
    """A read failed for a reason other than 'the key does not exist' (network, auth, 5xx ...)."""

MISSING_MARKERS = ("nosuchkey", "(404)", "404 ", "not found", "does not exist")

class Folder:
    """Destination = a local folder (tests)."""
    def __init__(self, path): self.path = os.path.abspath(path)
    def read(self, key):
        p = os.path.join(self.path, key)
        if not os.path.exists(p): return None
        try: return open(p, "rb").read()
        except OSError as e: raise ReadError(f"{key}: {e}")
    def put(self, key, src, cache):
        p = os.path.join(self.path, key); os.makedirs(os.path.dirname(p), exist_ok=True); shutil.copyfile(src, p)
    def stamps(self, layer):
        p = os.path.join(self.path, "data", layer)
        return sorted(d for d in os.listdir(p) if os.path.isdir(os.path.join(p, d))) if os.path.isdir(p) else []
    def remove(self, prefix): shutil.rmtree(os.path.join(self.path, prefix), ignore_errors=True)

class R2:
    """Destination = the R2 bucket, through the aws CLI (S3-compatible endpoint)."""
    def __init__(self):
        for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
            if not os.environ.get(k): sys.exit(f"missing environment variable {k}")
        self.bucket = os.environ.get("R2_BUCKET", "oceany-layers")
        self.env = dict(os.environ, AWS_ACCESS_KEY_ID=os.environ["R2_ACCESS_KEY_ID"],
                        AWS_SECRET_ACCESS_KEY=os.environ["R2_SECRET_ACCESS_KEY"], AWS_DEFAULT_REGION="auto",
                        AWS_REQUEST_CHECKSUM_CALCULATION="when_required", AWS_RESPONSE_CHECKSUM_VALIDATION="when_required")
        self.endpoint = f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    def aws(self, *args, check=True):
        quiet = ["--only-show-errors"] if args and args[0] in ("cp", "rm", "mv", "sync") else []  # `ls` rejects it
        return subprocess.run(["aws", "s3", *args, "--endpoint-url", self.endpoint, *quiet],
                              env=self.env, check=check, capture_output=True)
    def read(self, key):
        """The object's bytes; None only when the key does not exist (NoSuchKey / 404 in aws's stderr);
        any other failure raises ReadError, so a network blip is never mistaken for 'nothing published'."""
        try: r = self.aws("cp", f"s3://{self.bucket}/{key}", "-", check=False)
        except OSError as e: raise ReadError(f"{key}: could not run aws: {e}")
        if r.returncode == 0: return r.stdout
        err = r.stderr.decode(errors="replace")
        if any(m in err.lower() for m in MISSING_MARKERS): return None
        raise ReadError(f"{key}: aws exit {r.returncode}: {err.strip()[:300]}")
    def put(self, key, src, cache):
        ctype = "application/json" if key.endswith(".json") else "application/octet-stream"
        self.aws("cp", src, f"s3://{self.bucket}/{key}", "--cache-control", cache, "--content-type", ctype)
    def stamps(self, layer):
        r = self.aws("ls", f"s3://{self.bucket}/data/{layer}/", check=False)
        return sorted(l.split()[-1].rstrip("/") for l in r.stdout.decode().splitlines() if l.strip().startswith("PRE "))
    def remove(self, prefix): self.aws("rm", f"s3://{self.bucket}/{prefix}", "--recursive")
    def total_bytes(self):
        r = self.aws("ls", f"s3://{self.bucket}/", "--recursive", "--summarize", check=True)
        for line in r.stdout.decode().splitlines():
            if line.strip().startswith("Total Size:"):
                return int(line.split(":")[1])
        return None

def digest(paths):
    h = hashlib.sha256()
    for p in paths:
        h.update(os.path.basename(p).encode()); h.update(open(p, "rb").read())
    return h.hexdigest()

def main(argv):
    if "--dest" not in argv: sys.exit(__doc__)
    i = argv.index("--dest"); dest_arg = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
    extra = {}                                 # --extra '{"hurricanes": {"sourceModified": ...}}' from layer_due.py
    if "--extra" in argv:
        i = argv.index("--extra"); extra = json.loads(argv[i + 1] or "{}"); argv = argv[:i] + argv[i + 2:]
    max_gb = None
    if "--max-bucket-gb" in argv:
        i = argv.index("--max-bucket-gb"); max_gb = float(argv[i + 1]); argv = argv[:i] + argv[i + 2:]
    names = argv
    bad = [n for n in names if n not in LAYERS]
    if not names or bad: sys.exit(f"layers to publish: {', '.join(LAYERS)} (unknown: {bad})")
    dest = R2() if dest_arg == "r2" else Folder(dest_arg)

    if max_gb is not None and isinstance(dest, R2):
        new = 0
        for name in names:
            L = LAYERS[name]; d = os.path.join(ROOT, L["dir"])
            meta = json.load(open(os.path.join(d, L["files"][0])))
            new += sum(os.path.getsize(os.path.join(d, f)) for f in L["files"] + (L["more"](meta) if "more" in L else []))
        have = dest.total_bytes()
        if have is None: sys.exit("could not measure the bucket; nothing uploaded")
        print(f"bucket: {have / 1e9:.2f} GB now, this upload {new / 1e6:.1f} MB, limit {max_gb} GB")
        if have + new > max_gb * 1e9: sys.exit("would pass the limit; nothing uploaded")
    try:
        raw = dest.read("data/latest.json")
        latest = {"schema": 1, "layers": {}} if raw is None else json.loads(raw)   # only a missing key starts a new index
        if not isinstance(latest.get("layers"), dict): raise ValueError("no 'layers' object")
    except (ReadError, ValueError) as e:     # never overwrite the index with only this run's layers
        sys.exit(f"could not read data/latest.json ({e}); nothing uploaded")
    now = datetime.datetime.now(datetime.timezone.utc)
    changed, touched = [], []
    for name in names:
        L = LAYERS[name]
        first = os.path.join(ROOT, L["dir"], L["files"][0])
        meta = json.load(open(first))                          # the layer's own JSON comes first; it must parse
        files = L["files"] + (L["more"](meta) if "more" in L else [])
        paths = [os.path.join(ROOT, L["dir"], f) for f in files]
        missing = [p for p in paths if not os.path.exists(p) or os.path.getsize(p) == 0]
        if missing: sys.exit(f"{name}: missing or empty {missing}")
        sha = digest([p for p in paths if not p.endswith(".json")])   # the data itself; the JSON carries build times
        if "hash" in L: sha = hashlib.sha256(L["hash"](meta)).hexdigest()   # a JSON-only layer: its own content test
        old = latest["layers"].get(name)
        if old and old.get("sha256") == sha:
            src = (extra.get(name) or {}).get("sourceModified")
            if src and src != old.get("sourceModified"):   # remember the source was checked, so it is not rebuilt again
                old["sourceModified"] = src; touched.append(name)
            print(f"{name}: unchanged since {old.get('builtAt')}, nothing uploaded"); continue
        stamp = now.strftime("%Y%m%dT%H%M%SZ")
        base = f"data/{name}/{stamp}/"
        for f, p in zip(files, paths):
            dest.put(base + f, p, LONG_CACHE)
        entry = {"base": base, "files": files, "dataTime": None, "modelRun": None, "builtAt": None}
        entry.update({k: v for k, v in L["times"](meta).items() if v or v == 0})
        entry.update({k: v for k, v in (extra.get(name) or {}).items() if k in ("dataTime", "sourceModified") and v})
        entry["builtAt"] = entry["builtAt"] or now.strftime("%Y-%m-%dT%H:%M:%SZ")
        entry["publishedAt"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        entry["sha256"] = sha
        latest["layers"][name] = entry
        changed.append(name)
        print(f"{name}: uploaded {len(paths)} files to {base} (data time {entry['dataTime']})")
    if not changed and not touched: return
    latest["schema"] = 1
    latest["updated"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    latest["note"] = "Oceany globe layers. Research and play only: not a forecast or warning service."
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as t:
        json.dump(latest, t, indent=1); tmp = t.name
    dest.put("data/latest.json", tmp, SHORT_CACHE)
    os.unlink(tmp)
    # prune: keep the newest KEEP folders per layer (pages still open on an older folder keep working meanwhile)
    for name in changed:
        current = latest["layers"][name]["base"].split("/")[2]
        for s in dest.stamps(name)[:-LAYERS[name].get("keep", KEEP)]:
            if s != current: dest.remove(f"data/{name}/{s}/"); print(f"{name}: pruned {s}")

if __name__ == "__main__":
    main(sys.argv[1:])
