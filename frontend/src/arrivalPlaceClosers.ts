// arrivalPlaceClosers — the personal touch on arrival, chosen by WHAT the place is (2026-09-06).
//
// Jeff: "can it add a little personal touch like 'you have arrived at international motorsports,
// looking to buy a bike today?' or if its a chinese restaurant … 'get the ginger fried beef, I hear
// it's good'". The place type comes from the same Google nearby lookup that gives the name
// (src/placeIdentity.ts, Google Places (New) type names). Lines are Jeff's voice: playful, kind,
// at most 12 words, no dashes, no emoji, nothing that claims a fact about THIS business (type-level
// jokes only — "ginger beef" is a Chinese-restaurant line, not a menu fact). Pure; gated by
// tools/sim-qc/arrival_line_test.mts.

export type PlaceCloserRule = { types: readonly string[]; lines: readonly string[] };

export const PLACE_CLOSERS: readonly PlaceCloserRule[] = [
  { types: ["motorcycle_dealer", "motorcycle_shop", "motorcycle_repair_shop"],
    lines: ["Looking to buy a bike today?", "Try not to come home with two wheels.", "No signing anything without a test ride."] },
  { types: ["car_dealer", "used_car_dealer"],
    lines: ["Looking for a new ride?", "Kick the tires, then kick them again.", "Remember, the payment is monthly for a long time."] },
  { types: ["car_repair", "auto_parts_store", "tire_shop", "auto_body_shop", "car_detailing"],
    lines: ["Hope it's nothing serious.", "Get the good parts, not the cheap ones.", "Ask them to be gentle with her."] },
  { types: ["car_wash"], lines: ["Shine her up.", "Nothing beats a clean car on a sunny road."] },
  { types: ["gas_station"], lines: ["Fill her up.", "Premium only, you know the drill."] },
  { types: ["electric_vehicle_charging_station"], lines: ["Plug in and take a breather.", "Charge up, stretch your legs."] },
  { types: ["chinese_restaurant", "dim_sum_restaurant"],
    lines: ["Get the ginger fried beef, I hear it's good.", "Order the dim sum and don't share.", "Ginger beef and a side of dumplings, trust me."] },
  { types: ["japanese_restaurant", "sushi_restaurant"], lines: ["Get the spicy tuna, thank me later.", "Extra wasabi, you earned it."] },
  { types: ["ramen_restaurant"], lines: ["Tonkotsu, extra egg, no questions.", "Slurp loud, it's a compliment."] },
  { types: ["italian_restaurant", "pizza_restaurant"], lines: ["Carbs are earned after a drive like that.", "One more slice never hurt anyone."] },
  { types: ["mexican_restaurant", "taco_restaurant"], lines: ["Tacos first, questions later.", "Extra guac is always worth it."] },
  { types: ["indian_restaurant"], lines: ["Butter chicken, garlic naan, no regrets.", "Order it spicy, you're not driving for a while."] },
  { types: ["thai_restaurant"], lines: ["Green curry, medium spice, trust me.", "Pad thai never lets anyone down."] },
  { types: ["vietnamese_restaurant"], lines: ["Pho fixes everything.", "Get the banh mi too, you know you want it."] },
  { types: ["korean_restaurant", "korean_barbecue_restaurant"], lines: ["Do not skip the kimchi.", "Korean barbecue, let someone else do the grilling."] },
  { types: ["hamburger_restaurant", "fast_food_restaurant", "sandwich_shop"], lines: ["Double patty, you earned it.", "Fries on the side, it's a rule."] },
  { types: ["steak_house"], lines: ["Medium rare, anything else is a crime.", "Get the good cut, you drove for it."] },
  { types: ["seafood_restaurant", "fish_and_chips_restaurant"], lines: ["Get whatever came off the boat today.", "Fish and chips, extra vinegar."] },
  { types: ["breakfast_restaurant", "brunch_restaurant", "diner", "pancake_house"], lines: ["Pancakes, it's a rule.", "Coffee first, then decide."] },
  { types: ["restaurant", "food_court", "meal_takeaway", "meal_delivery", "buffet_restaurant", "fine_dining_restaurant", "family_restaurant", "american_restaurant", "greek_restaurant", "mediterranean_restaurant", "middle_eastern_restaurant", "lebanese_restaurant", "turkish_restaurant", "spanish_restaurant", "french_restaurant", "vegan_restaurant", "vegetarian_restaurant", "barbecue_restaurant", "pizza_delivery", "food"],
    lines: ["Ask what's best on the menu.", "Enjoy the meal.", "Order the thing you can't make at home."] },
  { types: ["cafe", "coffee_shop", "tea_house", "bubble_tea_store", "cat_cafe", "dog_cafe"], lines: ["Get the good coffee, not the cheap one.", "Coffee time, well earned.", "Bubble tea counts as a meal today."] },
  { types: ["bakery", "donut_shop", "bagel_shop"], lines: ["One pastry never hurt anybody.", "Get two, one is for the road."] },
  { types: ["ice_cream_shop", "dessert_shop", "dessert_restaurant", "candy_store", "chocolate_shop"], lines: ["Two scoops, it's a drive day.", "Dessert first is a valid plan."] },
  { types: ["bar", "pub", "night_club", "wine_bar", "cocktail_bar", "sports_bar"], lines: ["Enjoy, and grab a ride home.", "First round's on the drive, second round's on you."] },
  { types: ["brewery", "winery", "distillery"], lines: ["Taste, don't drive on it.", "Bring a bottle home instead."] },
  { types: ["gym", "fitness_center", "yoga_studio", "sports_club"], lines: ["Go get those gains.", "Leg day, no excuses."] },
  { types: ["park", "hiking_area", "national_park", "state_park", "campground", "picnic_ground", "garden", "botanical_garden"], lines: ["Fresh air time.", "Enjoy the trails.", "Leave only footprints."] },
  { types: ["beach", "swimming_pool", "water_park"], lines: ["Sunscreen and good vibes.", "Don't forget the towel."] },
  { types: ["golf_course"], lines: ["Keep it in the fairway.", "Play the ball where it lies."] },
  { types: ["ski_resort"], lines: ["Fresh tracks, go get them.", "Watch the ice on the way down."] },
  { types: ["shopping_mall", "clothing_store", "department_store", "store", "shoe_store", "electronics_store", "furniture_store", "home_goods_store", "sporting_goods_store", "book_store", "jewelry_store", "gift_shop", "discount_store", "warehouse_store", "market"],
    lines: ["Happy shopping, wallet beware.", "Buy something nice.", "Only what's on the list. Sure."] },
  { types: ["grocery_store", "supermarket", "convenience_store", "asian_grocery_store", "butcher_shop", "liquor_store"], lines: ["Don't shop hungry.", "Grab the snacks for the drive home."] },
  { types: ["hardware_store", "home_improvement_store"], lines: ["Every project needs one more trip.", "Measure twice."] },
  { types: ["movie_theater"], lines: ["Big popcorn, no sharing.", "Phones off, it's showtime."] },
  { types: ["casino"], lines: ["Set a limit and stick to it.", "Quit while you're ahead."] },
  { types: ["hotel", "lodging", "motel", "resort_hotel", "bed_and_breakfast", "inn", "hostel"], lines: ["Enjoy your stay.", "Time to unpack and unwind."] },
  { types: ["airport", "international_airport", "train_station", "bus_station", "ferry_terminal", "transit_station"], lines: ["Safe travels.", "Don't forget your passport."] },
  { types: ["hospital", "doctor", "dentist", "medical_clinic", "pharmacy", "physiotherapist", "chiropractor", "dental_clinic", "medical_lab"], lines: ["Hope everything goes well in there.", "Take care of yourself."] },
  { types: ["school", "university", "college", "library", "primary_school", "secondary_school", "preschool"], lines: ["Go learn something.", "Class is in session."] },
  { types: ["church", "place_of_worship", "mosque", "synagogue", "hindu_temple", "buddhist_temple"], lines: ["Have a peaceful one."] },
  { types: ["stadium", "sports_complex", "arena", "ice_skating_rink", "athletic_field"], lines: ["Go team.", "Enjoy the game."] },
  { types: ["amusement_park", "zoo", "aquarium", "museum", "tourist_attraction", "art_gallery", "planetarium", "bowling_alley", "amusement_center", "video_arcade"], lines: ["Have fun in there.", "Enjoy the show."] },
  { types: ["marina", "boat_launch"], lines: ["Fair winds.", "Enjoy the water."] },
  { types: ["bank", "atm"], lines: ["Hope the news is good.", "In and out, no lines."] },
  { types: ["barber_shop", "hair_salon", "beauty_salon", "spa", "nail_salon", "massage"], lines: ["Fresh cut, fresh start.", "Treat yourself."] },
  { types: ["veterinary_care", "pet_store", "dog_park"], lines: ["Give the good boy a scratch from me.", "Treats are mandatory."] },
  { types: ["race_track", "go_kart_track", "motor_sports"], lines: ["Keep it on the black stuff.", "Send it, responsibly."] },
];

/** Spoken when Google says the place is closed right now (only when it says so). */
export const CLOSED_CLOSER = "Heads up, they look closed right now.";

/** The rule for a place: primary type first, then any of its types, first rule wins. */
export function closerRuleFor(primaryType: string | null | undefined, types: readonly string[] | null | undefined): PlaceCloserRule | null {
  const p = (primaryType || "").toLowerCase();
  if (p) {
    const r = PLACE_CLOSERS.find((rule) => rule.types.includes(p));
    if (r) return r;
  }
  for (const t of types || []) {
    const r = PLACE_CLOSERS.find((rule) => rule.types.includes(String(t).toLowerCase()));
    if (r) return r;
  }
  return null;
}

let _lastPlaceLine = "";
/** Test seam. */
export function resetPlaceCloserMemory(): void { _lastPlaceLine = ""; }

/**
 * The closer for a resolved place, or null when its type has no rule. `quip` (generated for THIS
 * place, already validated) wins; a closed place gets the closed line; otherwise one line from the
 * type's pool, never the same line twice in a row.
 */
export function chooseArrivalPlaceCloser(
  place: { primaryType: string | null; types: readonly string[]; openNow?: boolean | null; quip?: string | null },
  rand: () => number = Math.random,
): { text: string; src: "quip" | "closed" | "type" } | null {
  if (place.quip) { _lastPlaceLine = place.quip; return { text: place.quip, src: "quip" }; }
  if (place.openNow === false) { _lastPlaceLine = CLOSED_CLOSER; return { text: CLOSED_CLOSER, src: "closed" }; }
  const rule = closerRuleFor(place.primaryType, place.types);
  if (!rule) return null;
  let pool = rule.lines.filter((l) => l !== _lastPlaceLine);
  if (!pool.length) pool = rule.lines.slice();
  const text = pool[Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)))];
  _lastPlaceLine = text;
  return { text, src: "type" };
}
