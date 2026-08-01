TESTWORLD Gold PDF Pipeline 04B
generatedAt: 2026-08-01T14:42:45.677Z
checked: 35
PASS: 35
FAIL: 0
ERROR: 0
Erfolgsquote: 100.0%

--- Dokumente ---

DOC-00001 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: werkvertrag
  Erwartet:             werkvertrag
  Family:               contract (erwartet contract) OK
  Summary:              OK
    erwartet: family=contract; facts=customer,project,site,gewerk
    tatsächlich: family=contract; facts=customer,project,site,gewerk
  CaseMatch:            OK
    erwartet: exact/PRJ-001
    tatsächlich: exact/PRJ-001
  Primäraktion:         OK (open_vorgang / erwartet open_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00002 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: angebot
  Erwartet:             angebot
  Family:               offer (erwartet offer) OK
  Summary:              OK
    erwartet: family=offer; facts=customer,subject,site
    tatsächlich: family=offer; facts=customer,subject,site
  CaseMatch:            OK
    erwartet: exact/PRJ-005
    tatsächlich: exact/PRJ-005
  Primäraktion:         OK (open_vorgang / erwartet open_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00003 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: eingangsrechnung
  Erwartet:             eingangsrechnung
  Family:               invoice_in (erwartet invoice_in) OK
  Summary:              OK
    erwartet: family=invoice_in; facts=supplier,date,site
    tatsächlich: family=invoice_in; facts=supplier,amount,date,site
  CaseMatch:            OK
    erwartet: multiple/null
    tatsächlich: multiple/null
  Primäraktion:         OK (select_vorgang / erwartet select_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00004 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: ausgangsrechnung
  Erwartet:             ausgangsrechnung
  Family:               invoice_out (erwartet invoice_out) OK
  Summary:              OK
    erwartet: family=invoice_out; facts=customer,date,vorgang
    tatsächlich: family=invoice_out; facts=customer,date,vorgang
  CaseMatch:            OK
    erwartet: exact/PRJ-001
    tatsächlich: exact/PRJ-001
  Primäraktion:         OK (open_vorgang / erwartet open_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00005 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: lieferschein
  Erwartet:             lieferschein
  Family:               delivery (erwartet delivery) OK
  Summary:              OK
    erwartet: family=delivery; facts=supplier,date,site,vorgang
    tatsächlich: family=delivery; facts=supplier,date,site,vorgang
  CaseMatch:            OK
    erwartet: multiple/null
    tatsächlich: multiple/null
  Primäraktion:         OK (select_vorgang / erwartet select_vorgang)
  Alerts:               OK (delivery-qty / erwartet delivery-qty)
  Gesamtstatus:         PASS

DOC-00006 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: tankbeleg
  Erwartet:             tankbeleg
  Family:               tank (erwartet tank) OK
  Summary:              OK
    erwartet: family=tank; facts=station,date
    tatsächlich: family=tank; facts=station,date,amount
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00007 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: eingangsrechnung
  Erwartet:             eingangsrechnung
  Family:               invoice_in (erwartet invoice_in) OK
  Summary:              OK
    erwartet: family=invoice_in; facts=supplier,date
    tatsächlich: family=invoice_in; facts=supplier,amount,date
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00008 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: finanzamt
  Erwartet:             finanzamt
  Family:               authority (erwartet authority) OK
  Summary:              OK
    erwartet: family=authority; facts=authority,subject
    tatsächlich: family=authority; facts=authority,subject,reference
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00009 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: bg_bau
  Erwartet:             bg_bau
  Family:               authority (erwartet authority) OK
  Summary:              OK
    erwartet: family=authority; facts=authority,subject
    tatsächlich: family=authority; facts=authority,subject,reference
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00010 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: sonstiges
  Erwartet:             sonstiges
  Family:               generic (erwartet generic) OK
  Summary:              OK
    erwartet: family=generic; facts=subject
    tatsächlich: family=generic; facts=subject
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (sender-uncertain / erwartet sender-uncertain)
  Gesamtstatus:         PASS

DOC-00011 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: aok
  Erwartet:             aok
  Family:               authority (erwartet authority) OK
  Summary:              OK
    erwartet: family=authority; facts=authority,subject
    tatsächlich: family=authority; facts=authority,subject,reference
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00012 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: eingangsrechnung
  Erwartet:             eingangsrechnung
  Family:               invoice_in (erwartet invoice_in) OK
  Summary:              OK
    erwartet: family=invoice_in; facts=supplier,date
    tatsächlich: family=invoice_in; facts=supplier,amount,date
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00013 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: brief
  Erwartet:             brief
  Family:               letter (erwartet letter) OK
  Summary:              OK
    erwartet: family=letter; facts=sender,subject
    tatsächlich: family=letter; facts=sender,subject
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00014 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: rechnung
  Erwartet:             rechnung
  Family:               invoice_in (erwartet invoice_in) OK
  Summary:              OK
    erwartet: family=invoice_in; facts=supplier,date
    tatsächlich: family=invoice_in; facts=supplier,invoiceNumber,amount,date
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00015 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: rechnung
  Erwartet:             rechnung
  Family:               invoice_in (erwartet invoice_in) OK
  Summary:              OK
    erwartet: family=invoice_in; facts=supplier,date
    tatsächlich: family=invoice_in; facts=supplier,invoiceNumber,amount,date
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00016 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: rechnung
  Erwartet:             rechnung
  Family:               invoice_in (erwartet invoice_in) OK
  Summary:              OK
    erwartet: family=invoice_in; facts=supplier,date
    tatsächlich: family=invoice_in; facts=supplier,invoiceNumber,amount,date
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00017 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: eingangsrechnung
  Erwartet:             eingangsrechnung
  Family:               invoice_in (erwartet invoice_in) OK
  Summary:              OK
    erwartet: family=invoice_in; facts=supplier,date
    tatsächlich: family=invoice_in; facts=supplier,amount,date
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00018 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: eingangsrechnung
  Erwartet:             eingangsrechnung
  Family:               invoice_in (erwartet invoice_in) OK
  Summary:              OK
    erwartet: family=invoice_in; facts=supplier,date
    tatsächlich: family=invoice_in; facts=supplier,amount,date
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00019 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: fahrzeugversicherung
  Erwartet:             fahrzeugversicherung
  Family:               authority (erwartet authority) OK
  Summary:              OK
    erwartet: family=authority; facts=authority,subject,reference
    tatsächlich: family=authority; facts=authority,subject,reference,amount
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00020 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: betriebshaftpflicht
  Erwartet:             betriebshaftpflicht
  Family:               authority (erwartet authority) OK
  Summary:              OK
    erwartet: family=authority; facts=authority,subject
    tatsächlich: family=authority; facts=authority,subject,amount
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00021 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: leasingvertrag
  Erwartet:             leasingvertrag
  Family:               generic (erwartet generic) OK
  Summary:              OK
    erwartet: family=generic; facts=sender,subject
    tatsächlich: family=generic; facts=sender,subject
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00022 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: tuev_bericht
  Erwartet:             tuev_bericht
  Family:               generic (erwartet generic) OK
  Summary:              OK
    erwartet: family=generic; facts=sender,subject
    tatsächlich: family=generic; facts=sender,subject,amount
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00023 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: reparaturrechnung
  Erwartet:             reparaturrechnung
  Family:               invoice_in (erwartet invoice_in) OK
  Summary:              OK
    erwartet: family=invoice_in; facts=supplier,date
    tatsächlich: family=invoice_in; facts=supplier,amount,date
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00024 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: arbeitsvertrag
  Erwartet:             arbeitsvertrag
  Family:               generic (erwartet generic) OK
  Summary:              OK
    erwartet: family=generic; facts=subject
    tatsächlich: family=generic; facts=sender,subject
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00025 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: krankmeldung
  Erwartet:             krankmeldung
  Family:               generic (erwartet generic) OK
  Summary:              OK
    erwartet: family=generic; facts=sender,subject
    tatsächlich: family=generic; facts=sender,subject
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00026 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: urlaubsantrag
  Erwartet:             urlaubsantrag
  Family:               generic (erwartet generic) OK
  Summary:              OK
    erwartet: family=generic; facts=subject
    tatsächlich: family=generic; facts=sender,subject
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00027 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: lohnabrechnung
  Erwartet:             lohnabrechnung
  Family:               generic (erwartet generic) OK
  Summary:              OK
    erwartet: family=generic; facts=sender,subject
    tatsächlich: family=generic; facts=sender,subject
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00028 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: handwerkskammer
  Erwartet:             handwerkskammer
  Family:               authority (erwartet authority) OK
  Summary:              OK
    erwartet: family=authority; facts=authority,subject
    tatsächlich: family=authority; facts=authority,subject,reference
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00029 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: brief
  Erwartet:             brief
  Family:               letter (erwartet letter) OK
  Summary:              OK
    erwartet: family=letter; facts=sender,subject
    tatsächlich: family=letter; facts=sender,subject
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00030 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: mahnung
  Erwartet:             mahnung
  Family:               invoice_in (erwartet invoice_in) OK
  Summary:              OK
    erwartet: family=invoice_in; facts=supplier,date
    tatsächlich: family=invoice_in; facts=supplier,amount,date
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00031 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: brief
  Erwartet:             brief
  Family:               letter (erwartet letter) OK
  Summary:              OK
    erwartet: family=letter; facts=sender,subject
    tatsächlich: family=letter; facts=sender,subject
  CaseMatch:            OK
    erwartet: exact/PRJ-001
    tatsächlich: exact/PRJ-001
  Primäraktion:         OK (open_vorgang / erwartet open_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00032 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: gutschrift
  Erwartet:             gutschrift
  Family:               invoice_in (erwartet invoice_in) OK
  Summary:              OK
    erwartet: family=invoice_in; facts=supplier,date
    tatsächlich: family=invoice_in; facts=supplier,amount,date
  CaseMatch:            OK
    erwartet: multiple/null
    tatsächlich: multiple/null
  Primäraktion:         OK (select_vorgang / erwartet select_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00033 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: gutschrift
  Erwartet:             gutschrift
  Family:               invoice_in (erwartet invoice_in) OK
  Summary:              OK
    erwartet: family=invoice_in; facts=date,site
    tatsächlich: family=invoice_in; facts=supplier,amount,date,site
  CaseMatch:            OK
    erwartet: exact/PRJ-001
    tatsächlich: exact/PRJ-001
  Primäraktion:         OK (open_vorgang / erwartet open_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00034 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: sonstiges
  Erwartet:             sonstiges
  Family:               generic (erwartet generic) OK
  Summary:              OK
    erwartet: family=generic; facts=subject
    tatsächlich: family=generic; facts=sender,subject
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

DOC-00035 — PASS
  extraction: pdf_direct (ocrAttempted=false)
  Dokumenttyp erkannt: sonstiges
  Erwartet:             sonstiges
  Family:               generic (erwartet generic) OK
  Summary:              OK
    erwartet: family=generic; facts=subject
    tatsächlich: family=generic; facts=sender,subject
  CaseMatch:            OK
    erwartet: none/null
    tatsächlich: none/null
  Primäraktion:         OK (create_vorgang / erwartet create_vorgang)
  Alerts:               OK (— / erwartet —)
  Gesamtstatus:         PASS

--- Abweichungen ---
(keine)
