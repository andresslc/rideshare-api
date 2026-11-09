const CITY_MILEAGE_BRACKETS = [
  { minMiles: 0, maxMiles: 4 },
  { minMiles: 5, maxMiles: 9 },
  { minMiles: 10, maxMiles: 15 },
  { minMiles: 16, maxMiles: 20 },
  { minMiles: 21, maxMiles: null },
];

function normalizeCity(city) {
  return typeof city === "string" ? city.trim().toLocaleLowerCase("en-US") : "";
}

function sortBrackets(brackets) {
  return [...brackets].sort((a, b) => a.minMiles - b.minMiles);
}

function hasRequiredCityBrackets(brackets) {
  if (
    !Array.isArray(brackets) ||
    brackets.length !== CITY_MILEAGE_BRACKETS.length
  ) {
    return false;
  }

  return sortBrackets(brackets).every((bracket, index) => {
    const required = CITY_MILEAGE_BRACKETS[index];
    return (
      bracket.minMiles === required.minMiles &&
      (bracket.maxMiles ?? null) === required.maxMiles
    );
  });
}

function findMileageBracket(brackets, miles) {
  return brackets.find((bracket) => {
    if (bracket.maxMiles == null) return miles >= bracket.minMiles;
    return miles >= bracket.minMiles && miles <= bracket.maxMiles;
  });
}

function calculateCityFare({
  price,
  miles,
  isPeak,
  peakSurchargePerMile = 0,
}) {
  const surcharge = isPeak ? peakSurchargePerMile : 0;
  const surchargeAmount = Number((surcharge * miles).toFixed(2));
  const ratePerMile = price + surcharge;

  return {
    surcharge,
    surchargeAmount,
    ratePerMile,
    totalFare: Number((ratePerMile * miles).toFixed(2)),
  };
}

module.exports = {
  CITY_MILEAGE_BRACKETS,
  normalizeCity,
  sortBrackets,
  hasRequiredCityBrackets,
  findMileageBracket,
  calculateCityFare,
};
