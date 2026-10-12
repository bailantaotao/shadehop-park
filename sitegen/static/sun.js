// Solar position — same formulas as pipeline/sun.py so map shadows match the precomputed timetable.
(function (g) {
  var rad = Math.PI / 180;
  g.sunPosition = function (date, lat, lng) {
    var n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
    var L = (280.460 + 0.9856474 * n) % 360;
    var gm = ((357.528 + 0.9856003 * n) % 360) * rad;
    var lam = (L + 1.915 * Math.sin(gm) + 0.020 * Math.sin(2 * gm)) * rad;
    var eps = (23.439 - 0.0000004 * n) * rad;
    var ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    var dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    var gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    var ha = (gmst * 15 + lng) * rad - ra;
    var phi = lat * rad;
    var alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
    var az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) / rad + 180;
    return { altitude: alt / rad, azimuth: ((az % 360) + 360) % 360 };
  };
})(window);
