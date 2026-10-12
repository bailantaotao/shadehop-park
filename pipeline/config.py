"""Region and modelling parameters.

Every assumption that affects a published number lives here so it can be
cited on the site and in llms.txt.
"""

REGION = {
    "id": "linkou",
    "id_prefix": "lk",
    "name": "林口區",
    "city": "新北市",
    "city_en": "New Taipei City",
    "name_en": "Linkou District",
    # Used only to locate the boundary relation; parks are filtered by the
    # real boundary polygon returned from OSM.
    "osm_city_name": "新北市",
    "osm_district_name": "林口區",
    "tdx_city": "NewTaipei",
}

# Extra margin around the district bbox for things that can serve a park
# near the edge (parking, chargers, buildings that cast shadows).
BBOX_MARGIN_M = 1500

# Search radii from a playground.
PARKING_RADIUS_M = 800
PARKING_MAX = 6
CHARGER_RADIUS_M = 2000
CHARGER_MAX = 8
AMENITY_RADIUS_M = 200
SHADOW_SEARCH_RADIUS_M = 400

# Geometry assumptions.
PLAYGROUND_NODE_RADIUS_M = 12  # playgrounds mapped as a single point
LEVEL_HEIGHT_M = 3.0  # per building:levels
DEFAULT_BUILDING_HEIGHT_M = 9.0  # building with no height/levels tag
VIADUCT_DECK_BOTTOM_M = 8.0
VIADUCT_DECK_TOP_M = 10.0
ROOF_HEIGHT_M = 3.0  # amenity=shelter / building=roof
SHELTER_NODE_RADIUS_M = 3.0
TREE_DEFAULT_CROWN_M = 6.0
TREE_DEFAULT_HEIGHT_M = 6.0

# Default deck widths (m) when a bridge has no width/lanes tag.
BRIDGE_WIDTH_BY_CLASS = {
    "motorway": 12.0,
    "trunk": 12.0,
    "primary": 10.0,
    "secondary": 9.0,
    "tertiary": 8.0,
    "motorway_link": 7.0,
    "trunk_link": 7.0,
    "primary_link": 7.0,
    "railway": 10.0,
}
BRIDGE_WIDTH_FALLBACK = 6.0
LANE_WIDTH_M = 3.5

# Shade timetable: month 1..12 (15th day), slots every 30 min from 06:00.
TIMETABLE_START_MIN = 6 * 60
TIMETABLE_SLOT_MIN = 30
TIMETABLE_SLOTS = 24  # 06:00 .. 17:30
MIN_SUN_ALTITUDE_DEG = 3.0  # below this the slot is "sun not up" (null)
TZ_OFFSET_H = 8  # Asia/Taipei, no DST

# Classification thresholds.
COVERED_FULL_RATIO = 0.5  # >= this share under a roof/viaduct -> level A
COVERED_PARTIAL_RATIO = 0.15
# A park with at least this much area under a viaduct (not pavilions) has a rain-proof play spot even if
# the share of the whole park is small.
COVERED_MIN_AREA_M2 = 150
SHADED_SLOT_RATIO = 0.6  # a slot counts as "shaded" at >= 60% coverage
LEVEL_C_MIN_DAYTIME_SHARE = 0.4  # share of 09-16 slots shaded, averaged over months

# A fact not re-verified within this many days is shown as stale.
STALE_AFTER_DAYS = 180
