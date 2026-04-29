from config import *
import dotenv
import os
import json
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import psycopg2
import pandas as pd
from datetime import datetime

dotenv.load_dotenv()

# Status -> threshold (in days). A profile is "stuck" if days_since_last_update > threshold.
STATUS_CRITERIA = {
    'readyToQueue':     2,
    'informedConsent':  2,
    'consentFailed':    2,
    'consentScheduled': 2,
    'hesitantToSign':   4,
    'signedAfterCall':  1,
    'signedBeforeCall': 1,
    'signedOnCall':     1,
    'salesEscalation':  3,
    'salesHandover':    3,
}


def createConnection():
    params = game_db_config()
    gameDbConn = psycopg2.connect(**params)
    gameDbCur = gameDbConn.cursor()
    return gameDbConn, gameDbCur


def get_mail_credentials():
    with open('mail_credentials.json') as json_file:
        data = json.load(json_file)
        return data['email'], data['password']


def getStuckInformedConsentReport(dbCursor):
    """
    For each patientSuccessStory row, take its created_at as the last status-update time
    (story_fresh holds the latest row per story_id), compute age in days, and keep only
    rows whose status is one of the tracked statuses AND whose age exceeds that status's
    threshold.

    Also joins contacts_fresh on origin to grab the assigned employee's contact info
    (email, first_name) so we can route each row to the right person.
    """
    status_conditions = " OR ".join([
        f"(status = '{status}' AND age_in_days > {threshold})"
        for status, threshold in STATUS_CRITERIA.items()
    ])

    query = f'''
    WITH pss AS (
        SELECT
            sf.destination AS profile_id,
            sf.origin AS assignee_contact_id,
            sf.status,
            sf.created_at AS status_updated_at,
            EXTRACT(EPOCH FROM (NOW() - sf.created_at)) / 86400 AS age_in_days
        FROM story_fresh AS sf
        WHERE sf.type = 'patientSuccessStory'
          AND sf.status IN ({", ".join("'" + s + "'" for s in STATUS_CRITERIA.keys())})
    )
    SELECT
        pss.profile_id,
        pss.assignee_contact_id,
        c.email AS assignee_email,
        c.first_name AS assignee_first_name,
        c.last_name AS assignee_last_name,
        pss.status,
        pss.status_updated_at,
        pss.age_in_days
    FROM pss
    LEFT JOIN contacts_fresh AS c
        ON c.contact_id = pss.assignee_contact_id
        AND c.type = 'salesperson' AND c.subtype = 'insideSales'
    WHERE {status_conditions}
    ORDER BY assignee_email, status, status_updated_at ASC;
    '''

    dbCursor.execute(query)
    columnNames = [desc[0] for desc in dbCursor.description]
    rows = dbCursor.fetchall()
    df = pd.DataFrame(rows, columns=columnNames)
    return df


def buildSummaryTable(df):
    """
    Build a single HTML table grouped by status with:
      - Status
      - Profile IDs (stuck in this status)
      - Criteria (> X days)
    Statuses with zero stuck profiles are omitted.
    """
    html = '''
    <table style="border-collapse: collapse; width: 100%; font-size: 13px; font-family: Arial, sans-serif;">
        <thead>
            <tr style="background-color: #2c3e50; color: white;">
                <th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Status</th>
                <th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Profile IDs (stuck)</th>
                <th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Criteria</th>
            </tr>
        </thead>
        <tbody>
    '''

    row_index = 0
    for status, threshold in STATUS_CRITERIA.items():
        status_df = df[df['status'] == status]
        if len(status_df) == 0:
            continue

        raw_ids = status_df['profile_id'].dropna().tolist()
        profile_ids = []
        for pid in raw_ids:
            if isinstance(pid, float):
                profile_ids.append(str(int(pid)))
            else:
                profile_ids.append(str(pid))
        profile_ids_display = ", ".join(profile_ids) if profile_ids else "—"
        criteria = f"&gt; {threshold} day{'s' if threshold != 1 else ''}"

        row_color = '#f9f9f9' if row_index % 2 == 0 else 'white'
        html += f'''
            <tr style="background-color: {row_color};">
                <td style="border: 1px solid #ddd; padding: 10px; vertical-align: top;"><strong>{status}</strong> ({len(status_df)})</td>
                <td style="border: 1px solid #ddd; padding: 10px; vertical-align: top;">{profile_ids_display}</td>
                <td style="border: 1px solid #ddd; padding: 10px; vertical-align: top;">{criteria}</td>
            </tr>
        '''
        row_index += 1

    html += '''
        </tbody>
    </table>
    '''
    return html


def sendStuckInformedConsentEmail(recipient_email, recipient_name, html_table, number_of_people):
    """Send the stuck-Informed-Consent report email to a single assignee."""
    try:
        email_user, email_password = get_mail_credentials()

        msg = MIMEMultipart()
        msg['From'] = 'service@motusnova.com'
        msg['To'] = recipient_email
        msg['Subject'] = f'{number_of_people} People stuck in Informed Consent'

        greeting_name = recipient_name if recipient_name else 'there'

        email_body = f'''
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2>People Stuck in Informed Consent</h2>
            <p>Hi {greeting_name},</p>
            <p>The table below lists the patients <strong>assigned to you</strong> whose last
            <code>patientSuccessStory</code> status update is older than the threshold for that
            status. The criteria column shows the age threshold (based on
            <code>story_fresh.created_at</code>) used to flag each status.</p>
            <p><strong>Total people stuck (assigned to you):</strong> {number_of_people}</p>
            {html_table}
            <p style="margin-top: 30px; color: #555; font-size: 12px;">
                This is an automated report. If anything looks off, message Parth.
            </p>
        </body>
        </html>
        '''

        msg.attach(MIMEText(email_body, 'html'))

        server = smtplib.SMTP('smtp.gmail.com', 587)
        server.starttls()
        server.login(email_user, email_password)
        server.send_message(msg)
        server.quit()

        print(f"✓ Email sent to {recipient_email} ({number_of_people} people stuck)")
        return True

    except Exception as e:
        print(f"✗ Failed to send email to {recipient_email}: {e}")
        return False


def main():
    print("=== Starting Stuck Informed Consent Report Script ===")

    dbConnection, dbCursor = createConnection()

    print("Fetching stuck patientSuccessStory data from database...")
    stuck_df = getStuckInformedConsentReport(dbCursor)
    total_stuck = len(stuck_df)
    print(f"Found {total_stuck} stuck profiles total\n")

    if total_stuck == 0:
        print("No profiles stuck. Nothing to email. Exiting.")
        dbCursor.close()
        dbConnection.close()
        return

    # Split out rows with no assignee email so we don't silently lose them.
    unassigned_mask = stuck_df['assignee_email'].isna() | (stuck_df['assignee_email'] == '')
    unassigned_df = stuck_df[unassigned_mask]
    assigned_df = stuck_df[~unassigned_mask]

    if len(unassigned_df) > 0:
        print(f"⚠ {len(unassigned_df)} stuck profile(s) have no assignee email and will be skipped:")
        for _, row in unassigned_df.iterrows():
            pid = row['profile_id']
            pid_str = str(int(pid)) if isinstance(pid, float) and not pd.isna(pid) else str(pid)
            print(f"    - profile_id={pid_str}, status={row['status']}, "
                  f"assignee_contact_id={row['assignee_contact_id']}")
        print()

    emails_sent = 0
    emails_failed = 0

    print("=== Sending per-assignee emails ===")
    for assignee_email, group_df in assigned_df.groupby('assignee_email'):
        first_row = group_df.iloc[0]
        assignee_name = first_row['assignee_first_name'] or ''
        number_of_people = len(group_df)

        print(f"\n--- {assignee_name} <{assignee_email}>: {number_of_people} stuck ---")
        for status, threshold in STATUS_CRITERIA.items():
            count = len(group_df[group_df['status'] == status])
            if count > 0:
                print(f"    - {status} (> {threshold} day{'s' if threshold != 1 else ''}): {count}")

        html_table = buildSummaryTable(group_df)
        if sendStuckInformedConsentEmail(assignee_email, assignee_name, html_table, number_of_people):
            emails_sent += 1
        else:
            emails_failed += 1

    print(f"\n=== Summary ===")
    print(f"Total stuck profiles: {total_stuck}")
    print(f"Unassigned (skipped): {len(unassigned_df)}")
    print(f"Emails sent: {emails_sent}")
    print(f"Emails failed: {emails_failed}")

    dbCursor.close()
    dbConnection.close()
    print("\n=== Script Complete ===")


if __name__ == "__main__":
    main()