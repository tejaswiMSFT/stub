/**
 * Help content.
 *
 * Kept apart from the controller because it is prose, not logic, and because the honesty
 * of some of it matters enough to be easy to find and revise. In particular the page on
 * removal: deleting an installed web app deletes its data with it, on both platforms,
 * with no warning from the operating system. Someone who has trusted this app with a
 * boarding pass deserves to have been told that plainly beforehand — not to discover it
 * the morning they travel.
 *
 * Written for a person, not a developer. No jargon, no "cache", no "IndexedDB".
 */

export function helpPages(platform) {
  return [
    {
      title: 'Install',
      body: platform.iosNonSafari ? iosOtherBrowser(platform) : platform.iOS ? iosInstall() : androidInstall(platform),
    },
    {
      title: 'Adding tickets',
      body: adding(platform),
    },
    {
      title: 'Managing tickets',
      body: managing(),
    },
    {
      title: 'Removing the app',
      body: removing(),
    },
    {
      title: 'Privacy',
      body: privacy(),
    },
  ];
}

function iosOtherBrowser(platform) {
  return `
    <p class="help-lead">On iPhone, only Safari can add an app to the Home Screen.</p>
    <p>
      That is Apple's restriction, not ours. ${platform.name} on iPhone uses the same
      engine as Safari underneath, but Apple does not offer <strong>Add to Home
      Screen</strong> anywhere except Safari itself.
    </p>
    <ol class="help-steps">
      <li>Tap <strong>Share</strong>, then <strong>Open in Safari</strong>.</li>
      <li>In Safari, tap <strong>Share</strong> again.</li>
      <li>Scroll down and choose <strong>Add to Home Screen</strong>.</li>
      <li>Tap <strong>Add</strong>.</li>
    </ol>
    <div class="help-note">
      You can carry on using ${platform.name} for everything else. Only the installation
      has to happen in Safari, and only once.
    </div>`;
}

function iosInstall() {
  return `
    <p class="help-lead">On iPhone and iPad, Safari adds this to your Home Screen.</p>
    <ol class="help-steps">
      <li><strong>Tap Share</strong> in the toolbar — the square with an arrow coming out of it.</li>
      <li><strong>Scroll down</strong> and tap <strong>Add to Home Screen</strong>.</li>
      <li><strong>Tap Add.</strong> The icon appears with your other apps.</li>
    </ol>
    <div class="help-note">
      <strong>Open it from the icon after that.</strong> The Home Screen version and the
      Safari tab keep separate tickets, so add tickets in the one you actually use. If you
      add it twice you will get two icons, each with its own tickets.
    </div>
    <p>There is no App Store, no account, and nothing to pay.</p>`;
}

function androidInstall(platform) {
  if (platform.firefox) {
    return `
      <p class="help-lead">Firefox offers only limited support for installing apps like this.</p>
      <p>
        Everything works perfectly well in the browser — tickets are saved, and it still
        works offline. But for a proper icon on your home screen, Chrome, Edge, Brave,
        Opera or Samsung Internet will install it fully.
      </p>
      ${platform.android ? `<ol class="help-steps">
        <li>Open Firefox's menu.</li>
        <li>Choose <strong>Install</strong> or <strong>Add to Home screen</strong> if it is offered.</li>
      </ol>` : ''}
      <div class="help-note">
        Your tickets stay in whichever browser you added them to. They are not shared
        between browsers, because nothing is uploaded anywhere.
      </div>`;
  }

  return `
    <p class="help-lead">${platform.name} installs this like any other app.</p>
    <ol class="help-steps">
      <li><strong>Tap Install</strong> when it is offered, or open the menu and choose
        <strong>Install app</strong>${platform.touch ? '' : ' — or use the install icon in the address bar'}.</li>
      <li><strong>Confirm.</strong> The icon appears with your other apps.</li>
    </ol>
    <p>It behaves like an installed app: its own icon, its own window, and it works offline.</p>
    <div class="help-note">
      <strong>On a computer?</strong> Scan the code on the front page to open this on your
      phone, which is where tickets are actually useful.
    </div>
    <p>There is no Play Store listing, no account, and nothing to pay.</p>`;
}

function adding(platform) {
  return `
    <p class="help-lead">Three ways in, depending on where your ticket lives.</p>

    <h3>A PDF</h3>
    <p>Tap <strong>+</strong>, then <strong>Choose a ticket</strong>, and pick the file.
    This is the most accurate route, because the text can be read directly rather than
    recognised from a picture.</p>

    <h3>A photo or screenshot</h3>
    <p>Same route — pick the image instead. The barcode usually reads well; the printed
    details are harder, so expect to correct a few.</p>

    <h3>An email</h3>
    <p>Many tickets are never attached as a file at all — they are simply the body of a
    message. Save the email, or copy it and paste it in.</p>

    ${platform.android ? `
    <div class="help-note">
      <strong>On Android you can share straight in.</strong> Open the ticket in Gmail or
      Files, tap Share, and pick Ticket.
    </div>` : ''}

    ${platform.iOS ? `
    <div class="help-note">
      <strong>On iPhone, open the app first.</strong> Safari does not let apps like this
      appear in the Share sheet, so tickets are added from inside the app rather than
      shared into it.
    </div>` : ''}

    <h3>Checking what was read</h3>
    <p>Anything uncertain is flagged before saving. Booking references, dates, service
    numbers and seats are checked hardest, because those are what get looked at when you
    travel. Correct anything wrong — your version is always kept.</p>`;
}

function managing() {
  return `
    <p class="help-lead">Tickets are yours to remove, and yours to take with you.</p>

    <h3>Removing one ticket</h3>
    <p>Open it and use the menu in the corner. That ticket goes; everything else stays.
    Your original file is never touched.</p>

    <h3>Past journeys</h3>
    <p>A ticket moves to <strong>Past</strong> six hours after it departs, rather than
    disappearing. Delays happen, and the booking reference is often needed weeks later for
    a refund or an expense claim.</p>

    <h3>Backing up</h3>
    <p>In <strong>Settings</strong>, tap <strong>Export a backup</strong>. You get a single
    file holding every ticket, which you can keep wherever you like. <strong>Restore from a
    backup</strong> brings them all back.</p>

    <div class="help-note">
      The backup is ordinary readable text. Nothing is locked to this app, and you can
      move your tickets elsewhere whenever you want.
    </div>`;
}

function removing() {
  return `
    <div class="help-warning">
      <strong>Deleting this app deletes your tickets with it.</strong>
      On both iPhone and Android, removing an app like this one removes everything stored
      inside it. There is no way to recover it afterwards, and nobody else has a copy —
      that is the direct consequence of nothing being uploaded anywhere.
    </div>

    <p><strong>Export a backup first</strong> if you might want your tickets again. It
    takes a moment, and it is the only way back.</p>

    <h3>How to remove it</h3>
    <p><strong>iPhone:</strong> press and hold the icon, then Remove App, then Delete App.</p>
    <p><strong>Android:</strong> press and hold the icon, then Uninstall.</p>

    <h3>Keeping the app, clearing the tickets</h3>
    <p>If you only want to start fresh, use <strong>Delete every ticket</strong> in
    Settings. The app stays where it is.</p>

    <h3>If your browser clears it</h3>
    <p>When installed, this app asks your browser to keep its data safe, and browsers
    normally agree for apps added to the Home Screen. If yours declines, Settings will say
    so — take a backup in that case.</p>`;
}

function privacy() {
  return `
    <p class="help-lead">There is no server. That is not a policy — it is the design.</p>

    <p>Your ticket is read here, in this app, on your device. Nothing is uploaded, because
    there is nowhere to upload it to. No account, no sign-in, no analytics, no tracking,
    and no third-party code fetched while you use it.</p>

    <h3>Your barcode is copied, never redrawn</h3>
    <p>The code on your ticket is taken exactly as it is and shown again unchanged. It is
    never rebuilt from the details we read, because a barcode that looks right and scans to
    something different would fail you at the gate with no warning.</p>

    <h3>Nothing is hidden from you</h3>
    <p>Every ticket records where each detail came from — the barcode, the printed text, or
    your own correction. Open a ticket and scroll down to see it.</p>

    <h3>Works with no signal</h3>
    <p>Everything is stored on your device, so the app opens on a plane, in a tunnel, or
    abroad with no roaming. It never needs a connection to show you a ticket.</p>

    <div class="help-note">
      This app is not issued by any airline, railway or operator. It reads tickets you
      already have. Keep your original with you.
    </div>`;
}
