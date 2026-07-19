let installed = false;

function install(pricing) {
  if (installed) return;
  const originalRound = pricing.round;
  pricing.round = (value) => originalRound(value + Number.EPSILON);
  installed = true;
}

module.exports = { install };
