"""Which live feeds apply to which spot (from live-feeds.md, re-checked against live calls 2026-11-16).

Each feed entry is (feed name in feeds.FETCHERS, keyword arguments). build_snapshot.py loops over these.
Coordinates are decimal degrees, lon negative west. lat/lon is the point the model cells are picked around.
No feed here is Open-Meteo any more (2026-11-23: its free tier is non-commercial). Waves and wind: NOAA GFS-Wave
(public domain) everywhere, Copernicus / DMI where they cover the spot. Tide: Copernicus regional sea level (tide + surge)
in Europe and the Med, NOAA CO-OPS predictions for Pipeline.

public: feed names that go into the slim public snapshot live/<spot>.json (build_snapshot.py --public). Every spot has
        one: the viewer reads nothing else (no browser call to any outside host).
excluded_public: feed -> why it stays out of the public file (terms unclear, or too slow for a scheduled job).
map_datum / msl_to_map_m: the datum of the spot's sea-floor map and the offset added to the forecast sea level (MSL)
        to get "tide above the map datum". Only Peniche has a measured offset (LAT = MSL - 1.66 m, notes/forecast-fields.md).
Name, lat/lon, map_datum and msl_to_map_m come from the spot registry ../spots.json (one place for every script);
this file adds the feeds. The viewer mirrors the table in pieces/01-seafloor/viewer/live_core.js (LIVE_SPOTS); change both together.
"""
import json
from pathlib import Path

REGISTRY = json.loads((Path(__file__).resolve().parent.parent / "spots.json").read_text())


def where(key):
    """name, lat, lon, map_datum, msl_to_map_m of one spot, from spots.json."""
    r = REGISTRY[key]
    return dict(name=r["name"], lat=r["lat"], lon=r["lon"], map_datum=r["datum"], msl_to_map_m=r["msl_to_datum_m"])


KYST_TERMS = "kystatlas.kyst.dk states no licence or terms of use (checked 2026-11-16); same buoy reaches the public file via Copernicus in-situ"

SPOTS = {
    "porto_batel": dict(
        **where("porto_batel"),   # the house; Stage A domain centre
        stage_a=True,                                                 # lookup table exists: pieces/06-live-wave/lookup/
        feeds=[
            ("gfs_wave", {}),
            ("cmems_wave", dict(dataset="cmems_mod_ibi_wav_anfc_0.027deg_PT1H-i", label="Copernicus IBI wave 0.027 deg")),
            ("cmems_sea_level", dict(dataset="cmems_mod_ibi_phy_anfc_0.027deg-2D_PT15M-i", label="Copernicus IBI sea level")),
            ("cmems_insitu", dict(platform="IR_TS_MO_6200199", label="Instituto Hidrografico buoy 6200199 (Copernicus in-situ)")),
        ],
        public=["gfs_wave", "cmems_wave", "cmems_sea_level"],
        excluded_public=dict(cmems_insitu="wave sensor NaN since 14 Nov 2026"),
    ),
    "klitmoller": dict(
        **where("klitmoller"), stage_a=False,
        feeds=[
            ("gfs_wave", {}),
            ("cmems_wave", dict(dataset="cmems_mod_nws_wav_anfc_1.5km_PT1H-i", label="Copernicus NWS wave 1.5 km")),
            ("cmems_sea_level", dict(dataset="cmems_mod_nws_phy-ssh_anfc_1.5km-2D_PT15M-i", label="Copernicus NWS sea level")),
            ("dmi_wam", dict(lon=8.2, lat=57.04)),
            ("kyst_buoy", dict(ident=2035, label="kyst.dk Fjaltring 2035", lat=56.47, lon=8.06)),
            ("cmems_insitu", dict(platform="NO_TS_MO_Fjaltring", label="Fjaltring (Copernicus in-situ)")),
            ("dmi_water_level", dict(station="21009", label="DMI Hanstholm 21009")),
        ],
        public=["gfs_wave", "cmems_wave", "dmi_wam", "cmems_sea_level", "cmems_insitu", "dmi_water_level"],
        excluded_public=dict(kyst_buoy=KYST_TERMS),
    ),   # datum: the North Sea maps carry no swell model, so no tide is applied to them
    "hvide_sande": dict(
        **where("hvide_sande"), stage_a=False,
        feeds=[
            ("gfs_wave", {}),
            ("cmems_wave", dict(dataset="cmems_mod_nws_wav_anfc_1.5km_PT1H-i", label="Copernicus NWS wave 1.5 km")),
            ("cmems_sea_level", dict(dataset="cmems_mod_nws_phy-ssh_anfc_1.5km-2D_PT15M-i", label="Copernicus NWS sea level")),
            ("dmi_wam", dict(lon=8.0, lat=56.0)),
            ("kyst_buoy", dict(ident=2041, label="kyst.dk Nymindegab 2041", lat=55.81, lon=7.94)),
            ("cmems_insitu", dict(platform="NO_TS_MO_Nymindegab", label="Nymindegab (Copernicus in-situ)")),
            ("dmi_water_level", dict(station="9005201", label="DMI Hvide Sande Havn 9005201")),
        ],
        public=["gfs_wave", "cmems_wave", "dmi_wam", "cmems_sea_level", "cmems_insitu", "dmi_water_level"],
        excluded_public=dict(kyst_buoy=KYST_TERMS),
    ),   # datum: no sea-floor map of Hvide Sande in the viewer
    "tel_aviv": dict(
        **where("tel_aviv"), stage_a=False,
        feeds=[
            ("gfs_wave", {}),
            ("cmems_wave", dict(dataset="cmems_mod_med_wav_anfc_4.2km_PT1H-i", label="Copernicus MED wave 4.2 km")),
            ("cmems_sea_level", dict(dataset="cmems_mod_med_phy-ssh_anfc_4.2km_PT15M-i", label="Copernicus MED sea level")),
        ],
        public=["gfs_wave", "cmems_wave", "cmems_sea_level"], excluded_public={},
    ),   # no sea-floor map of Tel Aviv in the viewer; no open buoy (live-feeds.md: IMS needs a key, IOLR did not respond)
    "pipeline": dict(
        **where("pipeline"),
        stage_a=True, stage_a_site="pipeline",                        # sites.PIPELINE; table pieces/06-live-wave/lookup_pipeline/
        feeds=[
            ("gfs_wave", {}),
            ("coops_tide", dict(station="1612340", label="NOAA CO-OPS tide prediction, Honolulu 1612340")),
            ("ndbc", dict(station="51201", label="NDBC 51201 Waimea")),
        ],   # CDIP 106 skipped: licence unchecked. Honolulu: nearest harmonic station with hourly MSL predictions
             # (Haleiwa 1612668 gives none, checked 2026-11-23); ~45 km away on the south shore, so timing and range differ a little.
        public=["gfs_wave", "coops_tide"],   # GFS-Wave hours with an exact Stage A run each (no buoy)
        excluded_public=dict(ndbc="51201 is owned by PacIOOS and its data provided by Scripps (CDIP, NDBC station page); "
                                  "CDIP terms: free public use 'provided that they are not altered in any way'. A model-minus-buoy "
                                  "bias is a derived value, so it stays out until Benn decides (checked 2026-11-16)"),
    ),   # datum: lidar on local MSL; CO-OPS station MSL taken as the same level (not checked)
    # Reef maps without a reef model: forecast numbers and the browser swell model.
    "supertubos": dict(
        **where("supertubos"), stage_a=False,
        feeds=[("gfs_wave", {}), ("cmems_wave", dict(dataset="cmems_mod_ibi_wav_anfc_0.027deg_PT1H-i", label="Copernicus IBI wave 0.027 deg")),
               ("cmems_sea_level", dict(dataset="cmems_mod_ibi_phy_anfc_0.027deg-2D_PT15M-i", label="Copernicus IBI sea level"))],
        public=["gfs_wave", "cmems_wave", "cmems_sea_level"], excluded_public={},
    ),   # datum: same Peniche LAT offset as Porto Batel (same 2011 lidar)
    "guethary": dict(
        **where("guethary"), stage_a=False,
        feeds=[("gfs_wave", {}), ("cmems_wave", dict(dataset="cmems_mod_ibi_wav_anfc_0.027deg_PT1H-i", label="Copernicus IBI wave 0.027 deg")),
               ("cmems_sea_level", dict(dataset="cmems_mod_ibi_phy_anfc_0.027deg-2D_PT15M-i", label="Copernicus IBI sea level"))],
        public=["gfs_wave", "cmems_wave", "cmems_sea_level"], excluded_public={},
    ),   # datum: IGN69 zero within ~0.2 m of mean level (simulate_swell_spot.py tide_note)
    "hossegor": dict(
        **where("hossegor"), stage_a=False,
        feeds=[("gfs_wave", {}), ("cmems_wave", dict(dataset="cmems_mod_ibi_wav_anfc_0.027deg_PT1H-i", label="Copernicus IBI wave 0.027 deg")),
               ("cmems_sea_level", dict(dataset="cmems_mod_ibi_phy_anfc_0.027deg-2D_PT15M-i", label="Copernicus IBI sea level"))],
        public=["gfs_wave", "cmems_wave", "cmems_sea_level"], excluded_public={},
    ),
}
