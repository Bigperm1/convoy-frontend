// Curated enthusiast-car presets — fast-tap onboarding.
// Each preset: { make, model, label?, emoji? }

export type CarPreset = { make: string; model: string; label?: string; emoji?: string };

export const CAR_PRESETS: CarPreset[] = [
  { make: "Porsche", model: "911 GT3 RS", emoji: "🏁" },
  { make: "Porsche", model: "Cayman GT4", emoji: "🟡" },
  { make: "BMW", model: "M3 Competition", emoji: "🇩🇪" },
  { make: "BMW", model: "M4 CSL", emoji: "🏎" },
  { make: "Nissan", model: "Skyline GT-R", emoji: "🗾" },
  { make: "Nissan", model: "GT-R Nismo", emoji: "🐉" },
  { make: "Toyota", model: "Supra Mk4", emoji: "🚗" },
  { make: "Toyota", model: "GR Corolla", emoji: "🟥" },
  { make: "Honda", model: "Civic Type R", emoji: "🔴" },
  { make: "Honda", model: "S2000", emoji: "🌸" },
  { make: "Subaru", model: "WRX STI", emoji: "🌟" },
  { make: "Mitsubishi", model: "Lancer Evo X", emoji: "⚡" },
  { make: "Audi", model: "RS6 Avant", emoji: "🔵" },
  { make: "Mercedes-AMG", model: "GT Black Series", emoji: "⚫" },
  { make: "Lamborghini", model: "Huracán STO", emoji: "🐂" },
  { make: "Ferrari", model: "488 GTB", emoji: "🐎" },
  { make: "McLaren", model: "720S", emoji: "🟠" },
  { make: "Chevrolet", model: "Corvette Z06", emoji: "🇺🇸" },
  { make: "Ford", model: "Mustang GT500", emoji: "🐎" },
  { make: "Dodge", model: "Challenger Hellcat", emoji: "👹" },
  { make: "Tesla", model: "Model S Plaid", emoji: "⚡" },
  { make: "Mazda", model: "RX-7", emoji: "🌀" },
  { make: "Mazda", model: "Miata MX-5", emoji: "🍃" },
];
