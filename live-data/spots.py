"""Which live feeds apply to which spot (from live-feeds.md, re-checked against live calls 2026-11-16).

Each feed entry is (feed name in feeds.FETCHERS, keyword arguments). build_snapshot.py loops over these.
Coordinates are decimal degrees, lon negative west. lat/lon is also the point the viewer asks Open-Meteo for.

public: feed names that go into the slim public snapshot live/<spot>.json (build_snapshot.py --public), or None for
        no public file (the viewer then fetches Open-Meteo itself and needs nothing else).
excluded_public: feed -> why it stays out of the public file (terms unclear, or too slow for a scheduled job).
map_datum / msl_to_map_m: the datum of the spot's sea-floor map and the offset added to Open-Meteo's sea level (MSL)
        to get "tide above the map datum". Only Peniche has a measured offset (LAT = MSL - 1.66 m, notes/forecast-fields.md).
The viewer mirrors this table in pieces/01-seafloor/viewer/live_core.js (LIVE_SPOTS); change both together.
"""

KYST_TERMS = "kystatlas.kyst.dk states no licence or terms of use (checked 2026-11-16); same buoy reaches the public file via Copernicus in-situ"

SPOTS = {
    "porto_batel": dict(
        name="Porto Batel (Peniche)", lat=39.319506, lon=-9.355772,   # the house; Stage A domain centre
        stage_a=True,                                                 # lookup table exists: pieces/06-live-wave/lookup/
        feeds=[
            ("open_meteo", {}),
            ("cmems_wave", dict(dataset="cmems_mod_ibi_wav_anfc_0.027deg_PT1H-i", label="Copernicus IBI wave 0.027 deg")),
            ("cmems_insitu", dict(platform="IR_TS_MO_6200199", label="Instituto Hidrografico buoy 6200199 (Copernicus in-situ)")),
        ],
        public=["open_meteo", "cmems_wave"],
        excluded_public=dict(cmems_insitu="wave sensor NaN since 14 Nov 2026"),
        map_datum="LAT", msl_to_map_m=1.66),
    "klitmoller": dict(
        name="Klitmoller", lat=57.04, lon=8.49, stage_a=False,
        feeds=[
            ("open_meteo", {}),
            ("cmems_wave", dict(dataset="cmems_mod_nws_wav_anfc_1.5km_PT1H-i", label="Copernicus NWS wave 1.5 km")),
            ("dmi_wam", dict(lon=8.2, lat=57.04)),
            ("kyst_buoy", dict(ident=2035, label="kyst.dk Fjaltring 2035", lat=56.47, lon=8.06)),
            ("cmems_insitu", dict(platform="NO_TS_MO_Fjaltring", label="Fjaltring (Copernicus in-situ)")),
            ("dmi_water_level", dict(station="21009", label="DMI Hanstholm 21009")),
        ],
        public=["open_meteo", "cmems_wave", "dmi_wam", "cmems_insitu", "dmi_water_level"],
        excluded_public=dict(kyst_buoy=KYST_TERMS),
        map_datum=None, msl_to_map_m=None),   # the North Sea maps carry no swell model, so no tide is applied to them
    "hvide_sande": dict(
        name="Hvide Sande", lat=56.00, lon=8.10, stage_a=False,
        feeds=[
            ("open_meteo", {}),
            ("cmems_wave", dict(dataset="cmems_mod_nws_wav_anfc_1.5km_PT1H-i", label="Copernicus NWS wave 1.5 km")),
            ("dmi_wam", dict(lon=8.0, lat=56.0)),
            ("kyst_buoy", dict(ident=2041, label="kyst.dk Nymindegab 2041", lat=55.81, lon=7.94)),
            ("cmems_insitu", dict(platform="NO_TS_MO_Nymindegab", label="Nymindegab (Copernicus in-situ)")),
            ("dmi_water_level", dict(station="9005201", label="DMI Hvide Sande Havn 9005201")),
        ],
        public=["open_meteo", "cmems_wave", "dmi_wam", "cmems_insitu", "dmi_water_level"],
        excluded_public=dict(kyst_buoy=KYST_TERMS),
        map_datum=None, msl_to_map_m=None),   # no sea-floor map of Hvide Sande in the viewer
    "tel_aviv": dict(
        name="Tel Aviv", lat=32.08, lon=34.76, stage_a=False,
        feeds=[
            ("open_meteo", {}),
            ("cmems_wave", dict(dataset="cmems_mod_med_wav_anfc_4.2km_PT1H-i", label="Copernicus MED wave 4.2 km")),
        ],
        public=["open_meteo", "cmems_wave"], excluded_public={},
        map_datum=None, msl_to_map_m=None),   # no sea-floor map of Tel Aviv in the viewer   # no open buoy (live-feeds.md: IMS needs a key, IOLR did not respond)
    "pipeline": dict(
        name="Pipeline (Oahu)", lat=21.665, lon=-158.053,
        stage_a=True, stage_a_site="pipeline",                        # sites.PIPELINE; table pieces/06-live-wave/lookup_pipeline/
        feeds=[
            ("open_meteo", {}),
            ("ndbc", dict(station="51201", label="NDBC 51201 Waimea")),
        ],   # CDIP 106 skipped: licence unchecked
        public=["open_meteo"],          # the public file carries Open-Meteo hours with an exact Stage A run each (no buoy)
        excluded_public=dict(ndbc="51201 is owned by PacIOOS and its data provided by Scripps (CDIP, NDBC station page); "
                                  "CDIP terms: free public use 'provided that they are not altered in any way'. A model-minus-buoy "
                                  "bias is a derived value, so it stays out until Benn decides (checked 2026-11-16)"),
        map_datum="LMSL", msl_to_map_m=0.0),   # lidar on local MSL; Open-Meteo MSL taken as the same level (not checked)
    # Reef maps with no feed of their own beyond Open-Meteo (fetched by the browser): no public snapshot.
    "supertubos": dict(
        name="Supertubos (Peniche)", lat=39.3398, lon=-9.3619, stage_a=False,
        feeds=[("open_meteo", {})], public=None, excluded_public={},
        map_datum="LAT", msl_to_map_m=1.66),   # same Peniche LAT offset as Porto Batel (same 2011 lidar)
    "guethary": dict(
        name="Guethary / Parlementia", lat=43.427718, lon=-1.611053, stage_a=False,
        feeds=[("open_meteo", {})], public=None, excluded_public={},
        map_datum="IGN69", msl_to_map_m=0.0),   # IGN69 zero within ~0.2 m of mean level (simulate_swell_spot.py tide_note)
    "hossegor": dict(
        name="Hossegor / La Graviere", lat=43.67562, lon=-1.443375, stage_a=False,
        feeds=[("open_meteo", {})], public=None, excluded_public={},
        map_datum="IGN69", msl_to_map_m=0.0),
}
