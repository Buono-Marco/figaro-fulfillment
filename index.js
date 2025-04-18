const { onRequest } = require('firebase-functions/v2/https');

const { google } = require("googleapis");
const { WebhookClient, Payload } = require("dialogflow-fulfillment");
const moment = require("moment-timezone");

process.env.DEBUG = "dialogflow:*"; // enables lib debugging statement
const fs = require("fs");

const serviceAccount = JSON.parse(
  fs.readFileSync("serviceAccount.json", "utf8")
); // Starts with {"type": "service_account",...
const config = JSON.parse(fs.readFileSync("config.json", "utf8"));

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

// tempo massimo dalla data corrente (ora) per effettuare la prenotazione
const showPickerDays = 30;
// tempo minimo dalla data corrente (ora) per effettuare la prenotazione
const minutiAnticipo = 15; // 15 minuti
// Definisci i giorni di chiusura (esempio: Domenica e Lunedì)
const giorniDiChiusura = [0, 1];
// Definisce i range orari
const rangeOrari = {
  Mattina: { start: "09:00", end: "13:00" },
  Pomeriggio: { start: "15:00", end: "20:00" },
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

exports.dialogflowFirebaseFulfillmentV2 = onRequest(
  (request, response) => {
    const agent = new WebhookClient({ request, response });

    function replaceTimeInDate(date, time) {
      console.log("replaceTimeInDate: " + date + " - " + time);

      // Se l'ora è 12 AM (mezzanotte), controlla il contesto e correggi
      if (time.hour() === 0 && date.hour() === 12) {
        // Se viene interpretata come mezzanotte, correggi a mezzogiorno
        time.hour(12);
      }
      
      // Applica l'ora, i minuti e i secondi da `time` a `date`
      date.hour(time.hour());
      date.minute(time.minute());
      date.second(time.second());

      // Restituisce la nuova data in formato ISO string, mantenendo il fuso orario "Europe/Rome"
      return date;
    }

    function calcolaDurataTotale(servizi) {
      // Restituisce la durata totale in minuti
      return servizi.reduce(
        (totale, servizio) => totale + durataServizi[servizio],
        0
      );
    }

    function calcolaEndTime(startTime, durataTotale) {
      return moment.tz(startTime, timezone).add(durataTotale, "minutes");
    }

    async function findOccupiedSlots(date) {
      console.log("findOccupiedSlots - start");
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
        console.log(
          "findOccupiedSlots - startTime: " + startTime + " endTime: " + endTime
        );

        const occupiedSlots = await queryFreeBusy(
          startTime.toISOString(),
          endTime.toISOString()
        );
        // Accumula gli slot occupati di tutti i range orari in un unico array
        occupiedSlotsOverall = occupiedSlotsOverall.concat(occupiedSlots);
      }
      console.log("findOccupiedSlots - end");

      return occupiedSlotsOverall;
    }

    async function queryFreeBusy(startTime, endTime) {
      console.log("queryFreeBusy - start");
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
      }
    }

    async function createCalendarEvent(
      customer,
      customerPhoneNumber,
      serviziBarbiere,
      startTime,
      endTime
    ) {
      try {
        // Dettagli dell'evento
        const event = {
          summary: `${customer} - ${customerPhoneNumber} - ${serviziBarbiere}`,
          description: `Prenotazione ${serviziBarbiere} per ${customer}, tel. ${customerPhoneNumber}`,
          start: {
            dateTime: startTime, // Assicurati che la data sia nel futuro
            timeZone: timezone, // Sostituisci con il tuo fuso orario
          },
          end: {
            dateTime: endTime, // +1 ora rispetto all'inizio
            timeZone: timezone, // Sostituisci con il tuo fuso orario
          },
        };

        // Aggiunge l'evento al calendario
        const res = await calendar.events.insert({
          auth: serviceAccountAuth,
          calendarId: calendarId,
          requestBody: event,
        });

        // Se l'evento viene aggiunto con successo, informa l'utente
        return {
          success: true,
          message: `Appuntamento registrato con successo! ID Evento: #${customerPhoneNumber}.`,
        };
      } catch (error) {
        console.log(error);
        return {
          success: false,
          message: "Si è verificato un errore durante l'aggiunta dell'appuntamento. Per favore, riprova più tardi.",
        };
      }
    }

    function handleWelcome(customText) {
      // Utilizza il valore di customText se è definito, non nullo, e non vuoto; altrimenti usa il testo predefinito
      let text = typeof customText === 'string' && customText.trim() !== "" 
        ? customText 
        : "Benvenuto! Sono Figaro il tuo assistente per gli appuntamenti. Cosa vuoi fare oggi, fissare un nuovo appuntamento o modificarne uno esistente?";
      const fulfillmentMessage = {
        text: text,
        buttons: [
          {
            label: "Nuovo",
            callBackData: "Nuovo Appuntamento",
          },
          {
            label: "Modifica",
            callBackData: "Modifica Appuntamento",
          },
        ],
      };

      agent.add(
        new Payload(agent.UNSPECIFIED, fulfillmentMessage, {
          sendAsMessage: true,
          rawPayload: true,
        })
      );
    }

    function handleReset(customText) {
      console.log("handleReset - start");

      agent.contexts.forEach((context) => {
        agent.context.delete(context.name);
      });

      handleWelcome(customText);
    }

    async function handleFallback() {
      const queryText = agent.query;
      const intentName = agent.intent;

      const values = [
        new Date().toISOString(),
        intentName,
        queryText,
        "Fallback triggered",
      ];

      try {
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
        text: "Scegli la data.",
        dataPicker: {
          showDays: showPickerDays,
          closingDays: giorniDiChiusura,
        },
        buttons: [
          {
            label: "Indietro",
            callBackData: "Torna ai servizi",
          },
        ],
      };

      agent.add(
        new Payload(agent.UNSPECIFIED, fulfillmentMessage, {
          sendAsMessage: true,
          rawPayload: true,
        })
      );
    }

    async function choseBandDay() {
      console.log("choseBandDay - start");
      const context = agent.contexts.find(
        (context) =>
          context.name === "ongoing-appointment" ||
          context.name === "ongoing-modify-appointment"
      );
      
      const { date, serviziBarbiere } = context.parameters;

      const appointmentDate = moment.tz(date, timezone);
      const durataTotale = calcolaDurataTotale(serviziBarbiere);

      const morningAvailableSlots = await checkAvailabilityForTimeBand(
        appointmentDate,
        "Mattina",
        durataTotale
      );
      const morningAvailable = morningAvailableSlots.length > 0;

      const afternoonAvailableSlots = await checkAvailabilityForTimeBand(
        appointmentDate,
        "Pomeriggio",
        durataTotale
      );
      const afternoonAvailable = afternoonAvailableSlots.length > 0;

      let fulfillmentMessage = "";

      if (!morningAvailable && !afternoonAvailable) {
        fulfillmentMessage = {
          text: "Non ci sono disponibilità per la data selezionata. Si prega di selezionare una nuova data.",
          dataPicker: {
            showDays: showPickerDays,
            closingDays: giorniDiChiusura,
          },
        };
      } else {
        fulfillmentMessage = {
          text: "Quando vuoi prenotare?",
          buttons: [
            {
              label: "Mattina",
              callBackData: "Mattina",
              disabled: !morningAvailable,
              hover: morningAvailable
                ? null
                : "nessuna disponibilità in questa fascia oraria",
            },
            {
              label: "Pomeriggio",
              callBackData: "Pomeriggio",
              disabled: !afternoonAvailable,
              hover: afternoonAvailable
                ? null
                : "nessuna disponibilità in questa fascia oraria",
            },
            {
              label: "Indietro",
              callBackData: "Torna alla data",
            },
          ],
        };
      }

      agent.add(
        new Payload(agent.UNSPECIFIED, fulfillmentMessage, {
          sendAsMessage: true,
          rawPayload: true,
        })
      );
    }

    async function choseBandDay() {
      console.log("choseBandDay - start");
      const context = agent.contexts.find(
        (context) =>
          context.name === "ongoing-appointment" ||
          context.name === "ongoing-modify-appointment"
      );
    
      console.log("choseBandDay - context");
      
      const { date, serviziBarbiere } = context.parameters;
      console.log(`choseBandDay - date: ${date} - serviziBarbiere: ${serviziBarbiere}`);

      const appointmentDate = moment.tz(date, timezone);
      const durataTotale = calcolaDurataTotale(serviziBarbiere);

      const morningAvailableSlots = await checkAvailabilityForTimeBand(
        appointmentDate,
        "Mattina",
        durataTotale
      );
      const morningAvailable = morningAvailableSlots.length > 0;
      console.log(`choseBandDay - morningAvailable: ${morningAvailable}`);

      const afternoonAvailableSlots = await checkAvailabilityForTimeBand(
        appointmentDate,
        "Pomeriggio",
        durataTotale
      );
      const afternoonAvailable = afternoonAvailableSlots.length > 0;
      console.log(`choseBandDay - afternoonAvailable: ${afternoonAvailable}`);

      let fulfillmentMessage = "";

      if (!morningAvailable && !afternoonAvailable) {
        fulfillmentMessage = {
          text: "Non ci sono disponibilità per la data selezionata. Si prega di selezionare una nuova data.",
          dataPicker: {
            showDays: showPickerDays,
            closingDays: giorniDiChiusura,
          },
        };
      } else {
        fulfillmentMessage = {
          text: "Quando vuoi prenotare?",
          buttons: [
            {
              label: "Mattina",
              callBackData: "Mattina",
              disabled: !morningAvailable,
              hover: morningAvailable
                ? null
                : "nessuna disponibilità in questa fascia oraria",
            },
            {
              label: "Pomeriggio",
              callBackData: "Pomeriggio",
              disabled: !afternoonAvailable,
              hover: afternoonAvailable
                ? null
                : "nessuna disponibilità in questa fascia oraria",
            },
            {
              label: "Indietro",
              callBackData: "Torna alla data",
            },
          ],
        };
      }

      agent.add(
        new Payload(agent.UNSPECIFIED, fulfillmentMessage, {
          sendAsMessage: true,
          rawPayload: true,
        })
      );
    }

    async function checkAvailabilityForTimeBand(date, timeBand, durataTotale) {
      console.log(
        "checkAvailabilityForTimeBand - date: " +
          date +
          " - timeBand: " +
          timeBand +
          " - durataTotale: " +
          durataTotale
      );
      const period = rangeOrari[timeBand];

      const start = getEffectiveStartTime(date, period);
      const end = moment.tz(
        date.format("YYYY-MM-DD") + "T" + period.end,
        timezone
      );

      if (!start) {
        console.log("checkAvailabilityForTimeBand - No available slots.");
        return []; // Nessuno slot disponibile, restituisce un array vuoto
      }

      console.log("checkAvailabilityForTimeBand - start: " + start + " - end: " + end);

      const occupiedSlots = await findOccupiedSlots(date);
      const availableSlots = [];
      let slotStart = start.clone();

      while (slotStart.isBefore(end) || slotStart.isSame(end, "minute")) {
        const slotEnd = slotStart.clone().add(durataTotale, "minutes");

        if (slotEnd.isAfter(end) && !slotEnd.isSame(end, "minute")) { break; }

        if (!isOverlapping(slotStart, slotEnd, occupiedSlots)) {
          availableSlots.push(slotStart.format("HH:mm"));
        }
        slotStart.add(15, "minutes"); // Incremento di 15 minuti
      }
      console.log("checkAvailabilityForTimeBand - end");
      // console.log(
      //   "checkAvailabilityForTimeBand - Available Slots (JSON):",
      //   JSON.stringify(availableSlots, null, 2)
      // );

      return availableSlots;
    }

    function getEffectiveStartTime(date, period) {
      const start = moment.tz(
        date.format("YYYY-MM-DD") + "T" + period.start,
        timezone
      );
      const end = moment.tz(
        date.format("YYYY-MM-DD") + "T" + period.end,
        timezone
      );
      const currentDateTime = moment.tz(timezone);

      if (date.isSame(currentDateTime, "day")) {
        let currentMoment = currentDateTime.add(minutiAnticipo, "minutes");

        // Se il momento attuale (più il buffer) è prima dell'inizio del periodo, impostalo all'inizio del periodo
        if (currentMoment.isBefore(start)) {
          currentMoment = start.clone();
        } else if (currentMoment.isAfter(end)) {
          // Se il momento attuale (più il buffer) è dopo la fine del periodo, non ci sono slot disponibili
          return null;
        } else {
          // Allinea l'orario al prossimo slot disponibile in base agli incrementi di 15 minuti
          const minutesPastStart = currentMoment.diff(start, "minutes");
          const remainder = minutesPastStart % 15;
          if (remainder !== 0) {
            currentMoment.add(15 - remainder, "minutes");
          }
        }

        return currentMoment;
      }

      return start; // Ritorna l'ora di inizio del periodo se la data non è oggi o l'ora attuale è prima dell'inizio
    }

    async function getAvailableSlots() {
      console.log("getAvailableSlots - start");
      const context = agent.contexts.find(
        (context) =>
          context.name === "ongoing-appointment" ||
          context.name === "ongoing-modify-appointment"
      );
      const { serviziBarbiere, date, timeBand } = context.parameters;
      console.log(
        "getAvailableSlots - serviziBarbiere: " +
          serviziBarbiere +
          " date: " +
          date +
          " timeBand: " +
          timeBand
      );

      const appointmentDate = moment.tz(date, timezone);
      const durataTotale = calcolaDurataTotale(serviziBarbiere);
      console.log(
        "getAvailableSlots - appointmentDate: " +
          appointmentDate +
          " durataTotale" +
          durataTotale
      );

      const availableSlots = await checkAvailabilityForTimeBand(
        appointmentDate,
        timeBand,
        durataTotale
      );

      const fulfillmentMessage = {
        text: "Ecco gli orari disponibili, a che ora vuoi prenotare?",
        buttons: [
          ...availableSlots.map((slot) => ({
            label: slot,
            callBackData: timeBand === "Mattina" ? `${slot} AM` : slot,
          })),
          {
            label: "Indietro",
            callBackData: "Torna alla timeband",
          },
        ],
      };

      agent.add(
        new Payload(agent.UNSPECIFIED, fulfillmentMessage, {
          sendAsMessage: true,
          rawPayload: true,
        })
      );
      console.log("getAvailableSlots - end");
    }

    function isOverlapping(start, end, occupiedSlots) {
      return occupiedSlots.some((slot) => {
        const slotStart = moment.tz(slot.start, timezone);
        const slotEnd = moment.tz(slot.end, timezone);
        return start.isBefore(slotEnd) && end.isAfter(slotStart);
      });
    }

    async function handleTimeSelection() {
      const context = agent.contexts.find(
        (context) => context.name === "ongoing-appointment"
      );
      const { customer, phoneNumber, serviziBarbiere, date, timeBand } =
        context.parameters;
      const time = agent.parameters.time;

      const appointmentDate = replaceTimeInDate(
        moment.tz(date, timezone),
        moment.tz(time, timezone)
      );
      const durataTotale = calcolaDurataTotale(serviziBarbiere);
      const endTime = calcolaEndTime(appointmentDate, durataTotale);

      const busy = await queryFreeBusy(appointmentDate, endTime);

      if (busy.length === 0) {
        console.log("Calendar is not busy, scheduling the event.");
        const result = await createCalendarEvent(
          customer,
          phoneNumber,
          serviziBarbiere,
          appointmentDate,
          endTime
        );

        let message = result.message;

        if (result.success) {
          handleReset(message +
            "\nCosa vuoi fare adesso, prenotare un Nuovo Appuntamento o Modificarne uno esistente?");
        } else {
          agent.add(message);
        }
      } else {
        console.log("Calendar is busy, finding alternative slots.");
        const availableSlots = await checkAvailabilityForTimeBand(
          appointmentDate,
          timeBand,
          durataTotale
        );

        if (availableSlots.length === 0) {
          agent.add(
            "Non ci sono orari disponibili per la fascia oraria scelta. Si prega di scegliere un'altra fascia oraria."
          );
        } else {
          const fulfillmentMessage = {
            text: "Lo slot selezionato è occupato. Ecco gli altri orari disponibili, a che ora vuoi prenotare?",
            buttons: availableSlots.map((slot) => ({
              label: slot,
              callBackData: timeBand === "Mattina" ? `${slot} AM` : slot,
            })),
          };

          agent.add(
            new Payload(agent.UNSPECIFIED, fulfillmentMessage, {
              sendAsMessage: true,
              rawPayload: true,
            })
          );
        }
      }
    }

    async function searchBooking() {
      const context = agent.contexts.find(
        (context) => context.name === "ongoing-modify-appointment"
      );
      const bookingNumber = context.parameters.bookingNumber;
      console.log("searchBooking: bookingNumber" + bookingNumber);
      const phoneNumber = bookingNumber.replace("#", "");
      const now = moment.tz(timezone).format();

      try {
        let pageToken = null;
        let matchedEvent = null;

        do {
          const response = await calendar.events.list({
            calendarId: calendarId,
            timeMin: now,
            q: phoneNumber,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 10, // Limita il numero di eventi per richiesta
            pageToken: pageToken,
          });

          const events = response.data.items;
          pageToken = response.data.nextPageToken;

          for (let event of events) {
            if (event.summary.includes(phoneNumber)) {
              matchedEvent = event;
              break;
            }
          }

          if (matchedEvent) {
            break;
          }
        } while (pageToken);

        if (matchedEvent) {
          const eventDateTime =
            matchedEvent.start.dateTime || matchedEvent.start.date;
          const formattedDate = moment(eventDateTime)
            .tz(timezone)
            .format("DD-MM-YYYY");
          const formattedTime = moment(eventDateTime)
            .tz(timezone)
            .format("HH:mm");
          const eventDetails = `${matchedEvent.summary} il ${formattedDate} alle ore ${formattedTime}`;
          const customer = extractCustomer(matchedEvent.summary);
          const eventId = matchedEvent.id;

          // Salva i dettagli dell'evento e l'ID nel contesto
          agent.context.set({
            name: "ongoing-modify-appointment",
            lifespan: 5,
            parameters: {
              eventId: eventId,
              phoneNumber: phoneNumber,
              customer: customer,
            },
          });

          const fulfillmentMessage = {
            text: `Ho trovato la tua prenotazione: ${eventDetails}. Vuoi confermare questa modifica?`,
            buttons: [
              {
                label: "Modifica Prenotazione",
                callBackData: "Modifica Prenotazione",
                disabled: false,
              },
              {
                label: "Cancella Appuntamento",
                callBackData: "Cancella Appuntamento",
                disabled: false,
              },
              {
                label: "Nuova Ricerca",
                callBackData: "Nuova Ricerca Appuntamento",
                disabled: false,
              },
            ],
          };

          agent.add(
            new Payload(agent.UNSPECIFIED, fulfillmentMessage, {
              sendAsMessage: true,
              rawPayload: true,
            })
          );
        } else {
          const fulfillmentMessage = {
            text: `Non ho trovato nessuna prenotazione con questo numero di telefono. Cosa vuoi fare?`,
            buttons: [
              {
                label: "Nuova Ricerca",
                callBackData: "Nuova Ricerca Appuntamento",
                disabled: false,
              },
              {
                label: "Torna al menù principale",
                callBackData: "menù principale",
                disabled: false,
              },
            ],
          };

          agent.add(
            new Payload(agent.UNSPECIFIED, fulfillmentMessage, {
              sendAsMessage: true,
              rawPayload: true,
            })
          );
        }
      } catch (error) {
        console.error("Error searching for event: ", error);
        agent.add(
          "Si è verificato un errore durante la ricerca della prenotazione. Per favore riprova più tardi."
        );
      }
    }

    // Funzione per estrarre il customer da eventDetails
    function extractCustomer(eventDetails) {
      const detailsParts = eventDetails.split(" - ");
      const customer = detailsParts.length > 0 ? detailsParts[0] : "";
      return customer;
    }

    async function modifyBooking() {
      const context = agent.contexts.find(
        (context) => context.name === "ongoing-modify-appointment"
      );
      const eventId = context.parameters.eventId;
      console.log("modifyBooking: eventId " + eventId);

      const tipoModifica = context.parameters.tipoModifica;
      console.log("modifyBooking: tipoModifica " + tipoModifica);

      switch (tipoModifica) {
        case "Modifica Prenotazione":
          // Imposta il contesto per catturare l'input delle modifiche
          agent.context.set({
            name: "004_service_modify_appointment",
            lifespan: 1,
            parameters: {
              eventId: eventId,
            },
          });
          // Invita l'utente a selezionare il servizio
          chooseServices();
          break;
        case "Cancella Appuntamento":
          await deleteAppointment(eventId);
          break;
        case "reset chat":
          handleReset(null);
          break;
        default:
          agent.add("Tipo di modifica non riconosciuto. Per favore riprova.");
      }
    }

    async function deleteAppointment() {
      const context = agent.contexts.find(
        (context) => context.name === "ongoing-modify-appointment"
      );
      const eventId = context.parameters.eventId;

      try {
        await calendar.events.delete({
          auth: serviceAccountAuth,
          calendarId: calendarId,
          eventId: eventId,
        });

        handleReset("L'appuntamento è stato cancellato con successo."+
          "\nCosa vuoi fare adesso, prenotare un Nuovo Appuntamento o Modificarne uno esistente?");
      } catch (error) {
        console.error("Error canceling event: ", error);
        agent.add(
          "Si è verificato un errore durante la cancellazione dell'appuntamento. Per favore riprova più tardi."
        );
      }
    }

    async function modifyTime() {
      const context = agent.contexts.find(
        (context) => context.name === "ongoing-modify-appointment"
      );
      const { eventId, customer, phoneNumber, serviziBarbiere, date, time } =
        context.parameters;

      try {
        const eventResponse = await calendar.events.get({
          calendarId: calendarId,
          eventId: eventId,
        });

        const event = eventResponse.data;

        const appointmentDate = replaceTimeInDate(
          moment.tz(date, timezone),
          moment.tz(time, timezone)
        );
        const durataTotale = calcolaDurataTotale(serviziBarbiere);
        const endTime = calcolaEndTime(appointmentDate, durataTotale);

        event.start = {
          dateTime: appointmentDate.toISOString(),
          timeZone: timezone,
        };
        event.end = {
          dateTime: endTime.toISOString(),
          timeZone: timezone,
        };

        event.summary = `${customer} - ${phoneNumber} - ${serviziBarbiere}`;
        event.description = `Prenotazione ${serviziBarbiere} per ${customer}, tel. ${phoneNumber}`;

        await calendar.events.update({
          auth: serviceAccountAuth,
          calendarId: calendarId,
          eventId: eventId,
          requestBody: event,
        });

        handleReset("L'appuntamento è stato modificato con successo!" +
          "\nCosa vuoi fare adesso, prenotare un Nuovo Appuntamento o Modificarne uno esistente?");
      } catch (error) {
        console.error("Error modifying event: ", error);
        agent.add(
          "Si è verificato un errore durante l'aggiornamento dell'appuntamento. Per favore riprova più tardi."
        );
      }
    }

    async function handlePrevious() {
      console.log("handlePrevious - start");
      const queryText = agent.query;
      console.log(`handlePrevious - queryText: ${queryText}`);

      switch (queryText) {
        case "Torna ai servizi":
          console.log("handlePrevious - servizi");
          agent.context.set({
            name: "04_add_service_new_appointment-followup",
            lifespan: 1,
            parameters: {
              action: "04_add_service_new_appointment.04_add_service_new_appointment-previous",
            },
          });
          chooseServices();
          break;
        case "Torna alla data":
          console.log("handlePrevious - data");
          agent.context.set({
            name: "05_add_day_new_appointment-followup",
            lifespan: 1,
            parameters: {
              action: "05_add_day_new_appointment.05_add_day_new_appointment-previous",
            },
          });
          selectDate();
          break;
        case "Torna alla timeband":
          console.log("handlePrevious - timeband");
          agent.context.set({
            name: "06_add_band_day_new_appointment-followup",
            lifespan: 1,
            parameters: {
              action: "06_add_band_day_new_appointment.06_add_band_day_new_appointment-previous",
            },
          });
          await choseBandDay();
          break;
        default:
          agent.add(
            "Si è verificato un errore durante la ricerca della prenotazione. Per favore riprova più tardi."
          );
      }     

      console.log("handlePrevious - end");
    }

    async function handlePreviousModify() {
      console.log("handlePreviousModify - start");
      const queryText = agent.query;
      console.log(`handlePreviousModify - queryText: ${queryText}`);

      switch (queryText) {
        case "Torna ai servizi":
          console.log("handlePreviousModify - servizi");
          agent.context.set({
            name: "004_service_modify_appointment-followup",
            lifespan: 1,
            parameters: {
              action: "004_service_modify_appointment.004_service_modify_appointment-previous",
            },
          });
          chooseServices();
          break;
        case "Torna alla data":
          console.log("handlePreviousModify - data");
          agent.context.set({
            name: "005_date_modify_appointment-followup",
            lifespan: 1,
            parameters: {
              action: "005_date_modify_appointment.005_date_modify_appointment-previous",
            },
          });
          selectDate();
          break;
        case "Torna alla timeband":
          console.log("handlePreviousModify - timeband");
          agent.context.set({
            name: "006_time_band_modify_appointment-followup",
            lifespan: 1,
            parameters: {
              action: "006_time_band_modify_appointment.006_time_band_modify_appointment-previous",
            },
          });
          await choseBandDay();
          break;
        default:
          agent.add(
            "Si è verificato un errore durante la ricerca della prenotazione. Per favore riprova più tardi."
          );
      }     

      console.log("handlePreviousModify - end");
    }

    // Run the proper function handler based on the matched Dialogflow intent name
    let intentMap = new Map();

    // Gestione creazione appuntamento
    intentMap.set("Default Welcome Intent", handleWelcome);
    intentMap.set("03_add_phone_new_appointment", chooseServices);
    intentMap.set("04_add_service_new_appointment", selectDate);
    intentMap.set("04_add_service_new_appointment - previous", handlePrevious); // chooseServices
    intentMap.set("05_add_day_new_appointment", choseBandDay);
    intentMap.set("05_add_day_new_appointment - previous", handlePrevious); // selectDate
    intentMap.set("06_add_band_day_new_appointment", getAvailableSlots);
    intentMap.set("06_add_band_day_new_appointment - previous", handlePrevious); // choseBandDay
    intentMap.set("07_add_time_new_appointment", handleTimeSelection);
    intentMap.set("08_reset_new_appointment", handleReset);
    
    // Gestione modifica appuntamento
    intentMap.set("002_book_number_modify_appointment", searchBooking);
    intentMap.set("003_choose_modify_appointment", modifyBooking);
    intentMap.set("004_service_modify_appointment", selectDate);
    intentMap.set("004_service_modify_appointment - previous", handlePreviousModify); // chooseServices
    intentMap.set("005_date_modify_appointment", choseBandDay);
    intentMap.set("005_date_modify_appointment - previous", handlePreviousModify); // selectDate
    intentMap.set("006_time_band_modify_appointment", getAvailableSlots);
    intentMap.set("006_time_band_modify_appointment - previous", handlePreviousModify); // choseBandDay
    intentMap.set("007_time_modify_appointment", modifyTime);
    intentMap.set("008_reset_modify_appointment", handleReset);

    // Intent generici
    intentMap.set("Default Fallback Intent", handleFallback);
    intentMap.set("Default Reset", handleReset);
    // intentMap.set('your intent name here', googleAssistantHandler);
    agent.handleRequest(intentMap);
  }
);