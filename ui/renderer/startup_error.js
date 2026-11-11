"use strict";

const detail = decodeURIComponent(window.location.hash.slice(1));
if (detail) document.getElementById("detail").textContent = detail;
