// legalContent.ts — single source of truth for the in-app legal pages, shared by
// the Settings → Legal routes AND the login-screen Terms/Privacy links.
// PRIVACY_POLICY is FINALISED (2026-07-25) and is the same text served at
// hairpin-site /privacy, which is the URL given to Google Play. Terms and Safety
// are still placeholders and carry `draft: true`, which renders the banner. `updated` is a
// plain string so there's no non-deterministic Date in the bundle.
import type { LegalSection } from "./components/LegalPage";

export const PRIVACY_POLICY: { title: string; updated: string; intro: string; sections: LegalSection[]; draft?: boolean } = {
  title: "Privacy Policy",
  updated: "25 July 2026",
  intro:
    "Hairpin is an app for driving together in a group. This policy explains what information the app collects, why it collects it, who it is shared with, and the choices you have. It applies to the Hairpin mobile app on iOS and Android, including the Apple CarPlay and Android Auto surfaces.",
  sections: [
    {
      heading: "Who We Are",
      body: "Hairpin is operated by its developers and owners (\u201cHairpin\u201d, \u201cwe\u201d, \u201cus\u201d). If you have any question about this policy or your data, contact us at support@hairpin.app.",
    },
    {
      heading: "Information We Collect",
      body:
        "Account information \u2014 your email address and, if you sign in with Apple or Google, a verified identifier from that provider.\n\n" +
        "Profile and vehicle \u2014 your handle, optional profile photo, and the car details you choose to enter (year, make, model, colour and appearance).\n\n" +
        "Location \u2014 precise GPS location while you use the app, including in the background when navigation, a convoy drive, or a connected car surface is active.\n\n" +
        "Voice and audio \u2014 recordings you make with push\u2011to\u2011talk, and voice you speak to the Scout assistant.\n\n" +
        "Content you create \u2014 hazard reports, saved places, routes, and messages you send to your crew.\n\n" +
        "Device and diagnostics \u2014 device model, operating system version, app and update version, a push notification token, and crash or error reports.",
    },
    {
      heading: "Location Data",
      body:
        "Location is the core of the app: it draws your car on the live convoy map, powers turn\u2011by\u2011turn navigation, positions hazard reports, and feeds the CarPlay and Android Auto map.\n\n" +
        "Hairpin collects location in the background so the map, navigation and the car display keep working while your phone is locked or the app is behind the head unit. You can revoke location access at any time in your device settings; the convoy map and navigation will not function without it.\n\n" +
        "Your live position is visible to members of clubs and conversations you have joined. It is never shown to the public or to people outside your crew. Your Avatar Live setting controls this: Full shares your live position while driving and your last parked position otherwise, Partial shares only while you are connected to your car, and Ghost shares nothing.",
    },
    {
      heading: "Voice and Audio",
      body:
        "Push\u2011to\u2011talk recordings are sent to our servers so they can be delivered to the crew or conversation you addressed them to. Voice spoken to Scout is sent to our servers and to a speech\u2011to\u2011text provider so the request can be transcribed and understood.\n\n" +
        "The microphone is only used while you are actively transmitting or speaking to Scout. Hairpin does not record or listen in the background.",
    },
    {
      heading: "How We Use Your Information",
      body:
        "To operate the convoy map, navigation, comms, hazard reporting and the car surfaces; to keep your account secure; to deliver notifications you have asked for; and to diagnose crashes and improve reliability. We do not use your information for advertising or profiling.",
    },
    {
      heading: "Sharing",
      body:
        "With your crew \u2014 your handle, avatar, vehicle appearance, position (per your Avatar Live setting), transmissions and hazard reports are shared with members of the clubs and conversations you join.\n\n" +
        "With service providers \u2014 we use third parties to run the app: map and routing providers, our hosting and database providers, a push\u2011notification service, a weather provider, and a speech\u2011to\u2011text provider. They process data only to provide their service to us.\n\n" +
        "Music services \u2014 if you connect Apple Music or Spotify, the app controls playback through that service. Your listening data is governed by that provider's own privacy policy.\n\n" +
        "We do not sell your personal information, and we do not share it with advertisers or data brokers. We may disclose information if required by law.",
    },
    {
      heading: "Retention and Deletion",
      body:
        "Account and profile data is kept while your account exists. Live positions are transient and are not kept as a location history. Transmissions and hazard reports are kept only as long as they are useful to your crew. Crash reports are kept for diagnostics.\n\n" +
        "You can ask us to delete your account and associated data at any time by emailing support@hairpin.app.",
    },
    {
      heading: "Security",
      body:
        "Data is sent over encrypted connections and access to our systems is restricted. No method of transmission or storage is completely secure, so we cannot guarantee absolute security.",
    },
    {
      heading: "Children",
      body:
        "Hairpin is intended for licensed drivers and is not directed at children. We do not knowingly collect information from children.",
    },
    {
      heading: "Your Rights",
      body:
        "You can access, correct or delete your information, withdraw permissions such as location, microphone or notifications in your device settings, and request a copy of your data. Contact support@hairpin.app.",
    },
    {
      heading: "Safety and Distracted Driving",
      body:
        "Hairpin is a driving aid. It is not a substitute for attentive, lawful driving, and it does not control your vehicle.\n\n" +
        "You are solely responsible for operating your vehicle safely and in accordance with all applicable laws. Set your destination, crew and preferences before you begin driving, and use hands\u2011free voice controls while under way. Do not read, type or interact with the app while the vehicle is moving.\n\n" +
        "Never allow the app, its notifications, comms, hazard reports or map to draw your attention from the road. Posted signs, road markings, traffic signals and real\u2011world conditions always take precedence over anything shown in the app.\n\n" +
        "Hairpin, its developers and its owners are not responsible for distracted driving or for any collision, injury, death, citation, loss or damage arising from your use of the app while operating a vehicle. Use of the app while driving is entirely at your own risk.",
    },
    {
      heading: "Disclaimers and Limitation of Liability",
      body:
        "The app is provided \u201cas is\u201d and \u201cas available\u201d, without warranties of any kind, whether express or implied, including any implied warranty of merchantability, fitness for a particular purpose or non\u2011infringement.\n\n" +
        "Routes, estimated arrival times, posted speed limits, speed\u2011camera locations, road\u2011incident data, crowd\u2011sourced hazard reports and the positions of other drivers may be inaccurate, incomplete, delayed or unavailable. Do not rely on them as your sole source of information.\n\n" +
        "To the maximum extent permitted by law, Hairpin, its developers, owners and contributors shall not be liable for any direct, indirect, incidental, special, consequential, exemplary or punitive damages, or for any loss of profits, data, goodwill, vehicle damage, personal injury or death, arising out of or in connection with your use of, or inability to use, the app \u2014 whether based in contract, tort, negligence, strict liability or otherwise, and whether or not we have been advised of the possibility of such damages.\n\n" +
        "Nothing in this policy excludes or limits liability that cannot lawfully be excluded or limited.",
    },
    {
      heading: "Changes to This Policy",
      body:
        "We may update this policy as the app changes. The date at the top shows when it was last revised, and continued use of the app after an update means you accept the revised policy.",
    },
    {
      heading: "Contact",
      body: "Questions about privacy, or a request to delete your data: support@hairpin.app.",
    },
  ],
};

export const TERMS_OF_SERVICE: { title: string; updated: string; intro: string; sections: LegalSection[]; draft?: boolean } = {
  draft: true,
  title: "Terms of Service",
  updated: "—",
  intro: "These terms govern your use of Hairpin. By using the app you agree to them. Replace this placeholder with your finalized terms.",
  sections: [
    { heading: "Using Hairpin", body: "You must be legally allowed to drive and follow all traffic laws. Hairpin is an aid, not a substitute for safe, attentive driving. [Placeholder.]" },
    { heading: "Accounts", body: "You’re responsible for your account and the accuracy of your profile, however you sign in (email, Apple, or Google). [Placeholder.]" },
    { heading: "Acceptable Use", body: "Don’t misuse comms, share hazardous or unlawful content, or interfere with other drivers. [Placeholder.]" },
    { heading: "Location & Navigation", body: "Routing, ETAs, hazards, and speed data may be inaccurate or delayed. Always rely on real-world conditions and road signs. [Placeholder.]" },
    { heading: "Data Attribution", body: "Road-incident data for British Columbia contains information licensed under the Open Government Licence – British Columbia, © Province of British Columbia (DriveBC Open511). Fixed speed-camera and speed-limit data © OpenStreetMap contributors, under the Open Database Licence (ODbL)." },
    { heading: "Disclaimers & Liability", body: "The app is provided “as is”. Add your warranty disclaimers and liability limits here. [Placeholder.]" },
    { heading: "Changes & Contact", body: "We may update these terms; continued use means acceptance. Questions: support@hairpin.app. [Placeholder.]" },
  ],
};

export const SAFETY_GUIDELINES: { title: string; updated: string; intro: string; sections: LegalSection[]; draft?: boolean } = {
  draft: true,
  title: "Safety Guidelines",
  updated: "—",
  intro: "Hairpin is built for the road, but nothing matters more than driving safely. Replace this placeholder with your finalized safety guidance.",
  sections: [
    { heading: "Eyes on the Road", body: "Set your destination, clubs, and preferences before you start driving. Use Scout’s hands-free voice replies instead of tapping. [Placeholder.]" },
    { heading: "Comms & Convoy", body: "Keep push-to-talk brief. Never let coordinating with your crew pull your attention from driving. [Placeholder.]" },
    { heading: "Hazard Reports", body: "Only report hazards when it’s safe — ideally as a passenger or via voice. Reports are crowd-sourced and may be inaccurate. [Placeholder.]" },
    { heading: "Speed & Limits", body: "Speed-limit and camera data can be wrong or outdated. Always obey posted signs and drive to conditions. [Placeholder.]" },
    { heading: "Emergencies", body: "In an emergency, pull over safely and call local emergency services. Hairpin is not an emergency service. [Placeholder.]" },
  ],
};
