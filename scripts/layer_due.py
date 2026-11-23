#!/usr/bin/env python3
"""Which globe layers need a new build? A few HEAD requests, standard library only, a few seconds.

Run by the refresh-layers workflow before anything is installed:
    python3 scripts/layer_due.py --latest latest.json ocean snow     (the layers this schedule may refresh)
latest.json is the published one from R2 (missing or empty file = nothing published yet). Prints one JSON line:
    {"due": ["ocean"], "plan": {"ocean": "2026112312"}, "extra": {"hurricanes": {...}}, "failed": []}
  due    layers whose source has something newer than what is published (only these are built)
  plan   ocean: the GFS run this check found on NOMADS (build_ocean.py --run uses exactly that run)
  extra  fields publish_layers.py adds to the layer's latest.json entry (the source file's Last-Modified time)
  failed layers whose check failed while the published copy is old: the workflow turns red for these

No request is sent when the published copy is already the one this run expects (ocean, snow): NOAA is asked only
when data is actually due. Rules per layer:
  ocean       the GFS run that should be out by now (cycle + 3 h 35 min). Published already: done, no request. Else two
              HEADs (the last kept hour's .idx of GFS and GFS-Wave): there = due; not there = missing, and the
              retry run 30 min later asks once more.
  snow        today's IMS file. Published already: done, no request. Else one HEAD: there = due; not there = missing.
  hurricanes  IBTrACS since-1980 file: due when its Last-Modified differs from the published one.
  tornadoes   SPC tornado file: the same.
  quakes      always due (weekly schedule); publish_layers.py uploads nothing when the result is byte-identical.
The URLs repeat the ones in the builders (build_ocean.py, build_snow.py, build_hurricanes.py, build_tornadoes.py):
change both together.
"""
import datetime, email.utils, json, sys, time, urllib.request

NOMADS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/"
IMS = "https://noaadata.apps.nsidc.org/NOAA/G02156/24km/{y}/ims{y}{d:03d}_00UTC_24km_v1.3.asc.gz"
IBTRACS = ("https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-"
           "ibtracs/v04r01/access/csv/ibtracs.since1980.list.v04r01.csv")
SPC = "https://www.spc.noaa.gov/wcm/data/1950-2025_actual_tornadoes.csv"
AGENT = {"User-Agent": "oceany-layer-check/1.0"}
UTC = datetime.timezone.utc
OLD_HOURS = {"ocean": 16, "snow": 48}      # a missing source is an error only when the published copy is older than this
RELEASE = datetime.timedelta(hours=3, minutes=35)   # NCEP: GFS / GFS-Wave hours 0-12 on NOMADS about 3 h 35 min after the cycle
LAST_STEP = 13                              # build_ocean.py STEPS[-1]

def head(url):
    """Last-Modified of a URL (a datetime), True when it exists without one, None when it does not exist."""
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers=AGENT, method="HEAD"), timeout=30)
        lm = r.headers.get("Last-Modified")
        return email.utils.parsedate_to_datetime(lm).astimezone(UTC) if lm else True
    except Exception:
        return None
    finally:
        time.sleep(0.3)                      # polite to NOMADS and NSIDC: never more than a few requests a second

iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
parse = lambda s: datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC) if s else None

def check_ocean(pub, now):
    # the run whose files should be out by now (NCEP posts hours 0-12 about 3 h 35 min after the cycle)
    cycle = now - RELEASE
    run = cycle.replace(minute=0, second=0, microsecond=0, hour=cycle.hour - cycle.hour % 6)
    old_run = parse(pub.get("modelRun"))
    if old_run and old_run >= run:
        return False, None                   # already published: no request to NOAA at all
    day, cyc = run.strftime("%Y%m%d"), run.strftime("%H")
    fhr = LAST_STEP                          # the last hour build_ocean.py keeps: when it is there, all are
    wind = f"{NOMADS}gfs.{day}/{cyc}/atmos/gfs.t{cyc}z.pgrb2.0p25.f{fhr:03d}.idx"
    wave = f"{NOMADS}gfs.{day}/{cyc}/wave/gridded/gfswave.t{cyc}z.global.0p25.f{fhr:03d}.grib2.idx"
    if head(wind) and head(wave):
        return True, run.strftime("%Y%m%d%H")
    return None, None                        # not posted yet: the retry run 30 min later asks once more

def check_snow(pub, now):
    d = now.date()                           # IMS posts the file for day D in the afternoon of day D (UTC)
    if pub.get("dataTime") == iso(datetime.datetime(d.year, d.month, d.day, tzinfo=UTC)):
        return False, None                   # already published: no request at all
    if head(IMS.format(y=d.year, d=d.timetuple().tm_yday)):
        return True, None
    return None, None                        # not posted yet: the retry run asks once more

def check_modified(url):
    def check(pub, now):
        lm = head(url)
        if lm is None:
            return None, None
        if lm is True:
            return True, None
        return iso(lm) != pub.get("sourceModified"), {"sourceModified": iso(lm), "dataTime": iso(lm)}
    return check

CHECKS = {"ocean": check_ocean, "snow": check_snow, "hurricanes": check_modified(IBTRACS),
          "tornadoes": check_modified(SPC), "quakes": lambda pub, now: (True, None)}

def main(argv):
    path = argv[argv.index("--latest") + 1]
    names = [a for a in argv if a in CHECKS]
    try:
        latest = json.load(open(path))
    except Exception:
        latest = {}
    layers = latest.get("layers") or {}
    now = datetime.datetime.now(UTC)
    out = {"due": [], "plan": {}, "extra": {}, "failed": []}
    for name in names:
        pub = layers.get(name) or {}
        due, info = CHECKS[name](pub, now)
        if due is None:                       # the source could not be reached
            age = (now - parse(pub["dataTime"])).total_seconds() / 3600 if pub.get("dataTime") else 1e9
            print(f"{name}: check failed (source not reachable)", file=sys.stderr)
            if age > OLD_HOURS.get(name, 24 * 40):
                out["failed"].append(name)
            continue
        if due:
            out["due"].append(name)
            if name == "ocean":
                out["plan"]["ocean"] = info
            elif info:
                out["extra"][name] = info
        print(f"{name}: {'due' if due else 'unchanged'}" + (f" ({info})" if due and info else ""), file=sys.stderr)
    print(json.dumps(out, separators=(",", ":")))

if __name__ == "__main__":
    main(sys.argv[1:])
