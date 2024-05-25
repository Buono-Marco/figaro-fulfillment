// See https://github.com/dialogflow/dialogflow-fulfillment-nodejs
// for Dialogflow fulfillment library docs, samples, and to report issues
"use strict";

const functions = require("firebase-functions");
const { google } = require("googleapis");
const { WebhookClient, Payload } = require("dialogflow-fulfillment");
const moment = require("moment-timezone");
require("dotenv").config();
const fs = require("fs");

process.env.DEBUG = "dialogflow:*"; // enables lib debugging statement
const serviceAccount = JSON.parse(
  fs.readFileSync("your_service_account.json", "utf8")
); // Starts with {"type": "service_account",...
const config = JSON.parse(fs.readFileSync("your_config.json", "utf8"));

// Set up Google Calendar Service account credentials
const serviceAccountAuth = new google.auth.JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/spreadsheets",
  ],
});

// Crea il client Google Sheets
const sheets = google.sheets({ version: "v4", auth: serviceAccountAuth });
const spreadsheetId = config.spreadsheetId; // looks like "3CCzbMLS990lKVetxD--5nwa_LMPAUIvCxSSldQfj5T2";

// Crea il client Google Calendar
const calendar = google.calendar({ version: "v3", auth: serviceAccountAuth });

// Enter your calendar ID below and service account JSON below, see https://github.com/dialogflow/bike-shop/blob/master/README.md#calendar-setup
const calendarId = config.calendarId; // looks like "6ujc6j6rgfk02cp02vg6h38cs0@group.calendar.google.com"

// ************************** Start Variabili attività ************************************
// ****************************************************************************************

// mostra un calendario a partire dalla data odierna più i giorni indicati nella variabile
const showPickerDays = 30;

// tempo minimo dalla data corrente (ora) per effettuare la prenotazione
const minutiAnticipo = 60; // 1 ora

// tempo massimo dalla data corrente (ora) per effettuare la prenotazione
const maxTime = 7; // in giorni

// Definisci i giorni di chiusura (esempio: Domenica e Lunedì)
const giorniDiChiusura = [0, 1];

// Definisce i range orari
const rangeOrari = {
  mattina: { start: "09:00", end: "13:00" },
  pomeriggio: { start: "15:00", end: "20:00" },
  // Aggiungi altri range orari se necessario
};

// Definisce la durata dei servizi
const durataServizi = {
  "Taglio capelli": 45,
  "Rasatura barba": 15,
  // Aggiungi altri servizi e le loro durate qui
};

const timezone = "Europe/Rome";

// ************************** End Variabili attività ************************************
// **************************************************************************************

exports.dialogflowFirebaseFulfillment = functions.https.onRequest(
  (request, response) => {
    const agent = new WebhookClient({ request, response });
    console.log(
      "Dialogflow Request headers: " + JSON.stringify(request.headers)
    );
    console.log("Dialogflow Request body: " + JSON.stringify(request.body));

    function replaceTimeInDate(date, time) {
      console.log(
        "****************************** [start replaceTimeInDate] ******************************"
      );
      console.log(
        "****************************** [replaceTimeInDate - date:" +
          date.format() +
          "] ******************************"
      );
      console.log(
        "****************************** [replaceTimeInDate - time:" +
          time.format() +
          "] ******************************"
      );

      const normalizedTime = normalizzaOrario(time);

      // Applica l'ora, i minuti e i secondi da `time` a `date`
      date.hour(normalizedTime.hour());
      date.minute(normalizedTime.minute());
      date.second(normalizedTime.second());

      // Restituisce la nuova data in formato ISO string, mantenendo il fuso orario "Europe/Rome"
      const result = date;
      console.log(
        "****************************** [replaceTimeInDate - result:" +
          result.format() +
          "] ******************************"
      );
      return result;
    }

    // Normalizza l'orario. Se ad es. l'utente intende le 4 PM ma DialogFlow lo interpreta come 4 AM
    function normalizzaOrario(time) {
      console.log(
        "****************************** [start normalizzaOrario] ******************************"
      );
      console.log(
        "****************************** [normalizzaOrario - time:" +
          time.format() +
          "] ******************************"
      );
      const hour = time.hour();

      console.log(
        "****************************** [normalizzaOrario - hour:" +
          hour +
          "] ******************************"
      );

      // Trasforma l'orario solo se è fuori dall'orario di apertura
      if (hour >= 21 || hour < 9) {
        // Calcola la nuova ora basandosi sulla differenza. E.g., 21 diventa 09, 22 diventa 10, ecc.
        let newHour = (hour + 12) % 24;
        console.log(
          "****************************** [normalizzaOrario - newHour:" +
            newHour +
            "] ******************************"
        );

        // Applica la nuova ora
        time.hour(newHour);
      }

      console.log(
        "****************************** [normalizzaOrario - time:" +
          time.format() +
          "] ******************************"
      );

      return time;
    }

    function calcolaDurataTotale(servizi) {
      console.log(
        "****************************** [start calcolaDurataTotale] ******************************"
      );
      let durataTotale = servizi.reduce((totale, servizio) => {
        //return servizi.reduce((totale, servizio) => {
        return totale + (durataServizi[servizio] || 0);
      }, 0);
      console.log(
        "****************************** [calcolaDurataTotale:" +
          durataTotale +
          "] ****************"
      );
      return durataTotale; // Restituisce la durata totale in minuti
    }

    function calcolaEndTime(startTime, durataTotale) {
      console.log(
        "****************************** [start calcolaEndTime] ******************************"
      );
      console.log(
        "****************************** [calcolaEndTime - startTime:" +
          startTime.format() +
          "] ******************************"
      );
      console.log(
        "****************************** [calcolaEndTime - durataTotale:" +
          durataTotale +
          "] ******************************"
      );
      // Crea un clone dell'oggetto moment per evitare di modificare l'originale
      const endTime = moment
        .tz(startTime, timezone)
        .add(durataTotale, "minutes");

      console.log(
        "****************************** [calcolaEndTime - endTime:" +
          endTime.format() +
          "] ******************************"
      );
      return endTime;
    }

    function verificaAnticipoMinimo(appointmentDate) {
      console.log(
        "****************************** [start verificaAnticipoMinimo] ******************************"
      );
      const oraCorrente = moment.tz(timezone);

      console.log(
        "****************************** [start verificaAnticipoMinimo - oraCorrente:" +
          oraCorrente.format() +
          "] ******************************"
      );
      const minutiDifferenza = appointmentDate.diff(oraCorrente, "minutes");
      console.log(
        "****************************** [start verificaAnticipoMinimo - minutiDifferenza:" +
          minutiDifferenza +
          "] ******************************"
      );
      return minutiDifferenza >= minutiAnticipo;
    }

    function verificaGiornoDiChiusura(appointmentDate) {
      console.log(
        "****************************** [start verificaGiornoDiChiusura] ******************************"
      );
      const giornoSettimana = appointmentDate.day();
      console.log(
        "****************************** [verificaGiornoDiChiusura - giornoSettimana:" +
          giornoSettimana +
          "] ******************************"
      );
      return giorniDiChiusura.includes(giornoSettimana);
    }

    function verificaRangeOrario(startTime, endTime) {
      console.log(
        "****************************** [start verificaRangeOrario] ******************************"
      );
      const startHour = moment(startTime).format("HH:mm");
      const endHour = moment(endTime).format("HH:mm");
      console.log(
        "****************************** [verificaRangeOrario - startHour:" +
          startHour +
          "] ******************************"
      );
      console.log(
        "****************************** [verificaRangeOrario - endHour:" +
          endHour +
          "] ******************************"
      );

      for (const range of Object.values(rangeOrari)) {
        if (startHour >= range.start && endHour <= range.end) {
          console.log(
            "****************************** [verificaRangeOrario - inRange: true] ******************************"
          );
          return true;
        }
      }

      return false;
    }

    function verificaDataPrenotazioneMax(appointmentDate) {
      console.log(
        "****************************** [start verificaDataPrenotazioneMax] ******************************"
      );
      const currentDate = moment.tz(timezone);
      const maxDate = currentDate.clone().add(maxTime, "days");

      console.log(
        `Verifica che la data dell'appuntamento ${appointmentDate.format()} non superi il massimo di ${maxDate.format()}`
      );

      return (
        appointmentDate.isBefore(maxDate) ||
        appointmentDate.isSame(maxDate, "day")
      );
    }

    async function addAppointment() {
      console.log(
        "****************************** [Start addAppointment] ******************************"
      );

      if (
        !agent.contexts.find((context) =>
          context.name.includes("ongoing-appointment")
        )
      ) {
        console.error("Context 'ongoing-appointment' non disponibile.");
        agent.add(
          "Si è verificato un errore tecnico. Per favore, riprova più tardi."
        );
        return;
      }

      const { lastname, name, phoneNumber, servizibarbiere, date, time } =
        agent.contexts.find((context) =>
          context.name.includes("ongoing-appointment")
        ).parameters;
      const customer = `${lastname} ${name}`;
      console.log(
        "****************************** [addAppointment - Customer: " +
          customer +
          " - PhoneNumer:" +
          phoneNumber +
          "] ******************************"
      );

      const appointmentDate = replaceTimeInDate(
        moment.tz(date, timezone),
        moment.tz(time, timezone)
      );
      const durataTotale = calcolaDurataTotale(servizibarbiere);
      const endTime = calcolaEndTime(appointmentDate, durataTotale);

      // Prima di procedere con altri controlli, verifica che la data non superi il limite massimo
      if (!verificaDataPrenotazioneMax(appointmentDate)) {
        agent.add(
          `La prenotazione non può essere effettuata oltre ${maxTime} giorni da oggi.`
        );
        return;
      }

      if (verificaGiornoDiChiusura(appointmentDate)) {
        agent.add(
          "Siamo spiacenti, il giorno scelto è un giorno di chiusura. Si prega di scegliere un altro giorno."
        );
        return;
      }

      if (!verificaRangeOrario(appointmentDate, endTime)) {
        agent.add(
          "L'orario scelto non rientra nei nostri orari di apertura. Si prega di scegliere un altro orario."
        );
        return;
      }

      if (!verificaAnticipoMinimo(appointmentDate)) {
        agent.add(
          `La prenotazione deve essere effettuata almeno ${minutiAnticipo} minuti in anticipo.`
        );
        return;
      }

      const result = await checkAvailability(
        customer,
        phoneNumber,
        servizibarbiere,
        appointmentDate,
        endTime,
        durataTotale
      );
      agent.add(result.message);
    }

    // Funzione per verificare la disponibilità
    async function checkAvailability(
      customer,
      customerPhoneNumber,
      serviziBarbiere,
      startTime,
      endTime,
      durataTotale
    ) {
      console.log(
        "****************************** [Start checkAvailability] ******************************"
      );
      try {
        const busy = await queryFreeBusy(startTime, endTime);

        if (busy.length === 0) {
          console.log("Calendar is not busy, scheduling the event.");
          return await createCalendarEvent(
            customer,
            customerPhoneNumber,
            serviziBarbiere,
            startTime,
            endTime
          );
        } else {
          console.log("Calendar is busy, searching for alternative slots.");
          return await handleAlternativeSlotsResponse(startTime, durataTotale);
        }
      } catch (error) {
        console.error(
          "[CheckAvailability] - Error during availability check:",
          error
        );
        return {
          success: false,
          message:
            "Technical error encountered. Please try again later, or contact support if the issue persists.",
        };
      }
    }

    async function handleAlternativeSlotsResponse(startTime, durataTotale) {
      console.log(
        "****************************** [start handleAlternativeSlotsResponse] ******************************"
      );
      console.log(
        "****************************** [handleAlternativeSlotsResponse - startTime:" +
          startTime.format() +
          "] ******************************"
      );
      console.log(
        "****************************** [handleAlternativeSlotsResponse - durataTotale:" +
          durataTotale +
          "] ******************************"
      );
      const alternatives = await findAlternativeSlots(startTime, durataTotale);
      let message = "";
      let success = false;

      if (alternatives.previous || alternatives.next) {
        console.log(
          "****************************** [handleAlternativeSlotsResponse alternatives:" +
            JSON.stringify(alternatives, null, 2) +
            "] ******************************"
        );
        message = "Orari alternativi disponibili:";
        success = true; // Considera la presenza di slot alternativi come un successo

        message += ` Prima: ${
          alternatives.previous
            ? moment.tz(alternatives.previous, timezone).format("HH:mm")
            : "Orario non disponibile prima dell'orario richiesto."
        }`;
        message += ` Dopo: ${
          alternatives.next
            ? moment.tz(alternatives.next, timezone).format("HH:mm")
            : "Orario non disponibile dopo dell'orario richiesto."
        }`;
      } else {
        message =
          "L'orario richiesto non è disponibile e non ci sono alternative disponibili.";
      }

      console.log(
        "****************************** [handleAlternativeSlotsResponse complete message:" +
          message +
          "] ******************************"
      );

      return {
        success: success,
        message: message,
      };
    }

    async function findAlternativeSlots(startTime, durataTotaleServizi) {
      console.log(
        "****************************** [Start findAlternativeSlots] ******************************"
      );
      console.log(
        "****************************** [findAlternativeSlots - startTime:" +
          startTime.format() +
          "] ******************************"
      );
      console.log(
        "****************************** [findAlternativeSlots - durataTotaleServizi:" +
          durataTotaleServizi +
          "] ******************************"
      );

      // Trova tutti gli slot occupati per il giorno specificato
      const occupiedSlots = await findOccupiedSlots(startTime);

      // Trova tutti gli slot liberi per il giorno specificato
      const freeSlots = await findFreeSlots(
        startTime,
        durataTotaleServizi,
        occupiedSlots
      );

      let previousSlot = null;
      let nextSlot = null;
      let smallestDiffPrev = Infinity;
      let smallestDiffNext = Infinity;

      freeSlots.forEach((slot) => {
        const slotStart = moment.tz(slot.start, "Europe/Rome");
        const slotEnd = moment.tz(slot.end, "Europe/Rome");
        console.log(
          "****************************** [findAlternativeSlots - freeSlots - slotStart:" +
            slotStart.format() +
            "] ******************************"
        );
        console.log(
          "****************************** [findAlternativeSlots - freeSlots - slotEnd:" +
            slotEnd.format() +
            "] ******************************"
        );

        const diffPrev = startTime.diff(slotEnd, "minutes");
        const diffNext = slotStart.diff(startTime, "minutes");

        // Trova il "start" più vicino e antecedente all'orario dell'utente
        if (diffPrev >= 0 && diffPrev < smallestDiffPrev) {
          // Assicurati che lo slot termini prima di startTime e sia il più vicino possibile
          smallestDiffPrev = diffPrev;
          previousSlot = slotEnd
            .subtract(durataTotaleServizi, "minutes")
            .format();
          console.log(
            "****************************** [findAlternativeSlots - previousSlot:" +
              previousSlot +
              "] ******************************"
          );
        }

        // Trova il "start" più vicino e successivo all'orario dell'utente
        if (diffNext >= 0 && diffNext < smallestDiffNext) {
          // Assicurati che lo slot inizi dopo startTime e sia il più vicino possibile
          smallestDiffNext = diffNext;
          nextSlot = slotStart.format();
          console.log(
            "****************************** [findAlternativeSlots - nextSlot:" +
              nextSlot +
              "] ******************************"
          );
        }
      });

      return { previous: previousSlot, next: nextSlot };
    }

    async function findFreeSlots(date, durataTotaleServizi, occupiedSlots) {
      console.log(
        "****************************** [Start findFreeSlots] ******************************"
      );
      console.log(
        "****************************** [findFreeSlots - date:" +
          date.format() +
          "] ******************************"
      );
      console.log(
        "****************************** [findFreeSlots - durataTotale:" +
          durataTotaleServizi +
          "] ******************************"
      );
      console.log(
        "****************************** [findFreeSlots - occupiedSlots:" +
          JSON.stringify(occupiedSlots, null, 2) +
          "] ******************************"
      );
      let freeSlots = [];

      // Genera slot di apertura come moment objects per il giorno specificato
      Object.keys(rangeOrari).forEach((key) => {
        const period = rangeOrari[key];
        freeSlots.push({
          start: moment.tz(
            `${date.format("YYYY-MM-DD")}T${period.start}`,
            timezone
          ),
          end: moment.tz(
            `${date.format("YYYY-MM-DD")}T${period.end}`,
            timezone
          ),
        });
      });

      // Ordina gli slot occupati per l'orario di inizio
      const sortedOccupiedSlots = occupiedSlots
        .map((slot) => ({
          start: moment.tz(slot.start, timezone),
          end: moment.tz(slot.end, timezone),
        }))
        .sort((a, b) => a.start.valueOf() - b.start.valueOf());

      // Calcola gli slot liberi sottraendo gli slot occupati dagli slot di apertura
      freeSlots = freeSlots.reduce((acc, slot) => {
        let currentStart = slot.start;

        sortedOccupiedSlots.forEach((occupied) => {
          console.log(
            "****************************** [findFreeSlots - sortedOccupiedSlots start:" +
              occupied.start.format() +
              " - end:" +
              occupied.end.format() +
              "] ******************************"
          );
          if (
            occupied.start.isBefore(slot.end) &&
            occupied.end.isAfter(currentStart)
          ) {
            if (occupied.start.isAfter(currentStart)) {
              acc.push({ start: currentStart, end: occupied.start });
            }
            currentStart = occupied.end;
          }
        });

        if (currentStart.isBefore(slot.end)) {
          acc.push({ start: currentStart, end: slot.end });
        }

        return acc;
      }, []);

      // Filtra gli slot per tenere solo quelli con durata maggiore o uguale a durataTotaleServizi
      const filteredFreeSlots = freeSlots.filter((slot) => {
        console.log(
          "****************************** [findFreeSlots - freeSlots start:" +
            slot.start.format() +
            " - end:" +
            slot.end.format() +
            "] ******************************"
        );
        return slot.end.diff(slot.start, "minutes") >= durataTotaleServizi;
      });

      // Mantieni gli slot in formato moment-timezone e restituisci
      return filteredFreeSlots;
    }

    async function findOccupiedSlots(date) {
      console.log(
        "****************************** [Start findOccupiedSlots] ******************************"
      );
      console.log(
        "****************************** [findOccupiedSlots - date:" +
          date.format() +
          "] ******************************"
      );
      let occupiedSlotsOverall = [];

      for (let periodKey in rangeOrari) {
        const period = rangeOrari[periodKey];
        const startTime = moment.tz(
          date.format("YYYY-MM-DD") + "T" + period.start,
          timezone
        );
        const endTime = moment.tz(
          date.format("YYYY-MM-DD") + "T" + period.end,
          timezone
        );

        try {
          const request = {
            resource: {
              timeMin: startTime.toISOString(),
              timeMax: endTime.toISOString(),
              timeZone: timezone,
              items: [{ id: calendarId }],
            },
          };

          const response = await calendar.freebusy.query(request);
          const occupiedSlots = response.data.calendars[calendarId].busy;
          console.log(`Occupied Slots for ${periodKey}: `, occupiedSlots);

          // Accumula gli slot occupati di tutti i range orari in un unico array
          occupiedSlotsOverall = occupiedSlotsOverall.concat(occupiedSlots);
        } catch (error) {
          console.error(
            `Error fetching occupied slots for ${periodKey}:`,
            error
          );
          // Considera se vuoi gestire l'errore in modo diverso, ad esempio interrompendo il ciclo.
        }
      }

      console.log(
        "****************************** [findOccupiedSlots - occupiedSlotsOverall:" +
          JSON.stringify(occupiedSlotsOverall, null, 2) +
          "] ******************************"
      );

      return occupiedSlotsOverall;
    }

    async function queryFreeBusy(startTime, endTime) {
      console.log(
        "****************************** [Query FreeBusy] ******************************"
      );
      console.log(`Start Time: (${startTime})`);
      console.log(`End Time: (${endTime})`);

      try {
        const request = {
          resource: {
            timeMin: startTime,
            timeMax: endTime,
            timeZone: timezone,
            items: [{ id: calendarId }],
          },
        };

        const response = await calendar.freebusy.query(request);
        return response.data.calendars[calendarId].busy;
      } catch (error) {
        console.error("Error fetching freebusy info:", error);
        throw error; // Oppure gestisci l'errore come preferisci
      }
    }

    async function createCalendarEvent(
      customer,
      customerPhoneNumber,
      serviziBarbiere,
      startTime,
      endTime
    ) {
      console.log(
        "****************************** [start createCalendarEvent] ******************************"
      );
      try {
        // Dettagli dell'evento di test
        const event = {
          summary: `Prenotazione ${serviziBarbiere} per ${customer}, tel. ${customerPhoneNumber}`,
          description: "Questo è un evento di test aggiunto da Dialogflow.",
          start: {
            dateTime: startTime, // Assicurati che la data sia nel futuro
            timeZone: timezone, // Sostituisci con il tuo fuso orario
          },
          end: {
            dateTime: endTime, // +1 ora rispetto all'inizio
            timeZone: timezone, // Sostituisci con il tuo fuso orario
          },
        };

        console.log(
          "****************************** [createCalendarEvent - event:" +
            event.summary +
            "] ******************************"
        );
        console.log(
          "****************************** [createCalendarEvent - start event:" +
            event.start.dateTime +
            "] ******************************"
        );
        console.log(
          "****************************** [createCalendarEvent - end event:" +
            event.end.dateTime +
            "] ******************************"
        );

        // Tenta di aggiungere l'evento al calendario
        const res = await calendar.events.insert({
          auth: serviceAccountAuth,
          calendarId: calendarId,
          requestBody: event,
        });

        // Se l'evento viene aggiunto con successo, informa l'utente
        return {
          success: true,
          message: `Appuntamento registrato con successo! ID Evento: ${res.data.id}`,
        };
      } catch (error) {
        console.log(error);
        return {
          success: false,
          message:
            "Si è verificato un errore durante l'aggiunta dell'appuntamento. Per favore, riprova più tardi.",
        };
      }
    }

    function handleWelcome() {
      const fulfillmentMessage = {
        text: "Benvenuto, sono qui per assisterti con i tuoi appuntamenti. Cosa vuoi fare?",
        buttons: [
          {
            label: "Nuovo App.",
            callBackData: "NuovoAppuntamento",
          },
          {
            label: "Modifica App.",
            callBackData: "ModificaAppuntamento",
          },
        ],
      };

      // Invia il payload come risposta al dialogflow
      agent.add(
        new Payload(agent.UNSPECIFIED, fulfillmentMessage, {
          sendAsMessage: true,
          rawPayload: true,
        })
      );
    }

    // Funzione per gestire il fallback
    async function handleFallback() {
      console.log(
        "****************************** [start handleFallback] ******************************"
      );
      const queryText = agent.query;
      const intentName = agent.intent;

      const values = [
        new Date().toISOString(), // Timestamp come ID
        intentName,
        queryText,
        "Fallback triggered", // Questo potrebbe essere personalizzato o statico
      ];

      try {
        console.log(
          "****************************** [handleFallback start try] ******************************"
        );
        await writeToSheet(values);
        agent.add(`Non sono sicuro di aver capito, puoi ripetere?`);
      } catch (error) {
        console.error("Error writing to sheet:", error);
        agent.add(
          `Si è verificato un errore durante la registrazione della tua richiesta.`
        );
      }
    }

    async function writeToSheet(values) {
      console.log(
        "****************************** [start writeToSheet] ******************************"
      );

      const range = "A2:D";
      const request = {
        spreadsheetId: spreadsheetId,
        range: range,
        valueInputOption: "USER_ENTERED",
        resource: {
          values: [values], // values è un array [ID, Intent, UserQuery, FallbackResponse]
        },
        auth: serviceAccountAuth,
      };

      try {
        console.log(
          "****************************** [writeToSheet start try] ******************************"
        );
        const response = await sheets.spreadsheets.values.append(request);
        console.log(response.data);
      } catch (err) {
        console.error("The API returned an error: " + err);
      }
    }

    function chooseServices() {
      const fulfillmentMessage = {
        text: "Scegli tra i seguenti servizi.",
        buttons: [
          {
            label: "Taglio Capelli",
            callBackData: "Taglio Capelli",
          },
          {
            label: "Barba",
            callBackData: "Rasatura Barba",
          },
          {
            label: "Capelli e Barba",
            callBackData: "Taglio Capelli e Rasatura Barba",
          },
        ],
      };

      // Invia il payload come risposta al dialogflow
      agent.add(
        new Payload(agent.UNSPECIFIED, fulfillmentMessage, {
          sendAsMessage: true,
          rawPayload: true,
        })
      );
    }

    function selectDate() {
      const fulfillmentMessage = {
        text: "Seleziona una data dal calendario qui sotto.",
        dataPicker: {
          showDays: showPickerDays,
          closingDays: giorniDiChiusura,
        },
      };

      agent.add(
        new Payload(agent.UNSPECIFIED, fulfillmentMessage, {
          sendAsMessage: true,
          rawPayload: true,
        })
      );
    }

    function choseBandDay() {
      const fulfillmentMessage = {
        text: "Quando vuoi prenotare?",
        buttons: [
          {
            label: "Mattina",
            callBackData: "Mattina",
          },
          {
            label: "Pomeriggio",
            callBackData: "Pomeriggio",
          },
        ],
      };

      // Invia il payload come risposta al dialogflow
      agent.add(
        new Payload(agent.UNSPECIFIED, fulfillmentMessage, {
          sendAsMessage: true,
          rawPayload: true,
        })
      );
    }

    // Run the proper function handler based on the matched Dialogflow intent name
    let intentMap = new Map();
    intentMap.set("Default Welcome Intent", handleWelcome);
    intentMap.set("phone.add - context: ongoing-appointment", chooseServices);
    intentMap.set("service.add - context: ongoing-appointment", selectDate);
    intentMap.set(
      "appointment.day.add - context: ongoing-appointment",
      choseBandDay
    );
    //intentMap.set("appointment.band-day.add - context: ongoing-appointment", choseBandDay)
    /* intentMap.set(
      "appointment.add - context: ongoing-appointment",
      addAppointment
    ); */
    intentMap.set("Default Fallback Intent", handleFallback);
    // intentMap.set('your intent name here', googleAssistantHandler);
    agent.handleRequest(intentMap);
  }
);
