/*
 * FINANZ-CORE-01A -- Feiertage an Fristenden (Paragraf 193 BGB), Nacharbeit zu WEISS-FAIL FC01A-END16-R1.
 *
 * Befund (WEISS, Gesamtendabnahme Bericht 16): Abschlag vom Di 21.04.2026, 2 % Skonto in 10 Tagen ab
 * Rechnungsdatum. Das Fristende Fr 01.05.2026 ist ein gesetzlicher Feiertag; die Zahlung am Mo 04.05.2026
 * galt als verspaetet (9,52 EUR offen), die Schlussrechnung wurde mit invoice_abschlag_unpaid abgewiesen.
 * 20261117 verschob nur Samstag/Sonntag.
 *
 * Entscheidung des Auftraggebers (15.10.2026):
 *  - Faellt das kalendarische Fristende auf Samstag, Sonntag oder einen gesetzlichen Feiertag am
 *    massgeblichen Ort, tritt der naechste Werktag an seine Stelle (Paragrafen 186, 193 BGB; OLG Hamm
 *    21 U 134/04). Massgeblich ist der Leistungsort der Zahlung, der Sitz des Kunden (Paragrafen 269,
 *    270 Abs. 4 BGB).
 *  - Ort: ausdrueckliche Angabe am Kunden (workspace_customers.payload.holidayLocation), sonst Land und
 *    PLZ der Rechnungsanschrift (dreistelliger Leitbereich, Obermenge der Laender aus GeoNames, CC BY 4.0),
 *    sonst unbekannt (alle Laender).
 *  - Ist der Ort nicht eindeutig (Grenz-PLZ, Gemeindefeiertag, unbekannt), entscheidet der Server nicht:
 *    Haengt das Skonto an einem solchen Tag, weist workspace_invoice_open_cents mit
 *    invoice_skonto_deadline_unclear ab -- Schlussrechnung, Zahlungsannahme und Bankabgleich auf diese
 *    Rechnung warten, bis der Ort am Kunden steht.
 *  - Ausland: ohne Bestaetigung am Kunden bleiben die drei Werktage nach dem (Sa/So-verschobenen) Ende
 *    ungeklaert.
 *  - Ausdruecklich abweichende Vereinbarung (payload.deadlineShiftWaived = true): kalendarisches Ende.
 *
 * Der Client rechnet dasselbe (src/services/fristen/feiertage.ts, fristende.ts); beide pruefen dieselben
 * Vektoren und dieselbe PLZ-Tabelle (md5 9225419144963c0adeff70fb690b2de8).
 *
 * Neu: Tabelle workspace_plz_leitbereiche (nur Lesedaten), Funktionen workspace_osterdatum,
 * workspace_feiertag_im_land, workspace_laender_fuer_plz, workspace_frist_tagstatus, workspace_fristfenster,
 * workspace_invoice_frist_lage. Ersetzt: workspace_invoice_open_cents (20261117). Rechte: nur Eigentuemer.
 * workspace_shift_to_working_day (20261117) bleibt bestehen, wird hier nicht mehr verwendet.
 *
 * Setzt 20261114120000 bis 20261117120000 voraus. Nur lokal angewendet;
 * Produktion: 20261114 -> 20261115 -> 20261116 -> 20261117 -> 20261118 -> Client.
 */

create table if not exists public.workspace_plz_leitbereiche (
  leitbereich text primary key check (leitbereich ~ '^[0-9]{3}$'),
  laender text[] not null check (cardinality(laender) > 0),
  augsburg text not null check (augsburg in ('ja', 'nein', 'teils'))
);

alter table public.workspace_plz_leitbereiche enable row level security;
revoke all on table public.workspace_plz_leitbereiche from public, anon, authenticated, service_role;

delete from public.workspace_plz_leitbereiche;
insert into public.workspace_plz_leitbereiche (leitbereich, laender, augsburg) values
  ('010', array['SN'], 'nein'),
  ('011', array['SN'], 'nein'),
  ('012', array['SN'], 'nein'),
  ('013', array['SN'], 'nein'),
  ('014', array['SN'], 'nein'),
  ('015', array['SN'], 'nein'),
  ('016', array['SN'], 'nein'),
  ('017', array['SN'], 'nein'),
  ('018', array['SN'], 'nein'),
  ('019', array['BB', 'SN'], 'nein'),
  ('026', array['SN'], 'nein'),
  ('027', array['SN'], 'nein'),
  ('028', array['SN'], 'nein'),
  ('029', array['SN'], 'nein'),
  ('030', array['BB'], 'nein'),
  ('031', array['BB'], 'nein'),
  ('032', array['BB'], 'nein'),
  ('041', array['SN'], 'nein'),
  ('042', array['SN'], 'nein'),
  ('043', array['SN'], 'nein'),
  ('044', array['SN'], 'nein'),
  ('045', array['SN'], 'nein'),
  ('046', array['SN', 'TH'], 'nein'),
  ('047', array['SN'], 'nein'),
  ('048', array['BB', 'SN'], 'nein'),
  ('049', array['BB'], 'nein'),
  ('061', array['ST'], 'nein'),
  ('062', array['ST'], 'nein'),
  ('063', array['ST'], 'nein'),
  ('064', array['ST'], 'nein'),
  ('065', array['ST', 'TH'], 'nein'),
  ('066', array['ST'], 'nein'),
  ('067', array['ST'], 'nein'),
  ('068', array['ST'], 'nein'),
  ('069', array['ST'], 'nein'),
  ('073', array['TH'], 'nein'),
  ('074', array['TH'], 'nein'),
  ('075', array['TH'], 'nein'),
  ('076', array['TH'], 'nein'),
  ('077', array['TH'], 'nein'),
  ('078', array['TH'], 'nein'),
  ('079', array['SN', 'TH'], 'nein'),
  ('080', array['SN'], 'nein'),
  ('081', array['SN'], 'nein'),
  ('082', array['SN'], 'nein'),
  ('083', array['SN'], 'nein'),
  ('084', array['SN'], 'nein'),
  ('085', array['SN'], 'nein'),
  ('086', array['SN'], 'nein'),
  ('091', array['SN'], 'nein'),
  ('092', array['SN'], 'nein'),
  ('093', array['SN'], 'nein'),
  ('094', array['SN'], 'nein'),
  ('095', array['SN'], 'nein'),
  ('096', array['SN'], 'nein'),
  ('101', array['BE'], 'nein'),
  ('102', array['BE'], 'nein'),
  ('103', array['BE'], 'nein'),
  ('104', array['BE'], 'nein'),
  ('105', array['BE'], 'nein'),
  ('106', array['BE'], 'nein'),
  ('107', array['BE'], 'nein'),
  ('108', array['BE'], 'nein'),
  ('109', array['BE'], 'nein'),
  ('110', array['BE'], 'nein'),
  ('120', array['BE'], 'nein'),
  ('121', array['BE'], 'nein'),
  ('122', array['BE'], 'nein'),
  ('123', array['BE'], 'nein'),
  ('124', array['BE'], 'nein'),
  ('125', array['BB', 'BE'], 'nein'),
  ('126', array['BE'], 'nein'),
  ('130', array['BE'], 'nein'),
  ('131', array['BE'], 'nein'),
  ('133', array['BE'], 'nein'),
  ('134', array['BE'], 'nein'),
  ('135', array['BE'], 'nein'),
  ('136', array['BE'], 'nein'),
  ('140', array['BE'], 'nein'),
  ('141', array['BE'], 'nein'),
  ('144', array['BB'], 'nein'),
  ('145', array['BB'], 'nein'),
  ('146', array['BB'], 'nein'),
  ('147', array['BB', 'ST'], 'nein'),
  ('148', array['BB'], 'nein'),
  ('149', array['BB'], 'nein'),
  ('152', array['BB'], 'nein'),
  ('153', array['BB'], 'nein'),
  ('155', array['BB'], 'nein'),
  ('157', array['BB'], 'nein'),
  ('158', array['BB'], 'nein'),
  ('159', array['BB'], 'nein'),
  ('162', array['BB'], 'nein'),
  ('163', array['BB'], 'nein'),
  ('165', array['BB'], 'nein'),
  ('167', array['BB'], 'nein'),
  ('168', array['BB'], 'nein'),
  ('169', array['BB'], 'nein'),
  ('170', array['MV'], 'nein'),
  ('171', array['MV'], 'nein'),
  ('172', array['BB', 'MV'], 'nein'),
  ('173', array['BB', 'MV'], 'nein'),
  ('174', array['MV'], 'nein'),
  ('175', array['MV'], 'nein'),
  ('180', array['MV'], 'nein'),
  ('181', array['MV'], 'nein'),
  ('182', array['MV'], 'nein'),
  ('183', array['MV'], 'nein'),
  ('184', array['MV'], 'nein'),
  ('185', array['MV'], 'nein'),
  ('186', array['MV'], 'nein'),
  ('190', array['MV'], 'nein'),
  ('192', array['MV', 'NI'], 'nein'),
  ('193', array['BB', 'MV'], 'nein'),
  ('194', array['MV'], 'nein'),
  ('200', array['HH'], 'nein'),
  ('201', array['HH'], 'nein'),
  ('202', array['HH'], 'nein'),
  ('203', array['HH'], 'nein'),
  ('204', array['HH'], 'nein'),
  ('205', array['HH'], 'nein'),
  ('210', array['HH', 'SH'], 'nein'),
  ('211', array['HH'], 'nein'),
  ('212', array['NI'], 'nein'),
  ('213', array['NI'], 'nein'),
  ('214', array['NI', 'SH'], 'nein'),
  ('215', array['NI', 'SH'], 'nein'),
  ('216', array['NI'], 'nein'),
  ('217', array['NI'], 'nein'),
  ('220', array['HH'], 'nein'),
  ('221', array['HH', 'SH'], 'nein'),
  ('222', array['HH'], 'nein'),
  ('223', array['HH'], 'nein'),
  ('224', array['HH'], 'nein'),
  ('225', array['HH'], 'nein'),
  ('226', array['HH'], 'nein'),
  ('227', array['HH'], 'nein'),
  ('228', array['SH'], 'nein'),
  ('229', array['SH'], 'nein'),
  ('235', array['SH'], 'nein'),
  ('236', array['SH'], 'nein'),
  ('237', array['SH'], 'nein'),
  ('238', array['SH'], 'nein'),
  ('239', array['MV', 'SH'], 'nein'),
  ('241', array['SH'], 'nein'),
  ('242', array['SH'], 'nein'),
  ('243', array['SH'], 'nein'),
  ('244', array['SH'], 'nein'),
  ('245', array['SH'], 'nein'),
  ('246', array['SH'], 'nein'),
  ('247', array['SH'], 'nein'),
  ('248', array['SH'], 'nein'),
  ('249', array['SH'], 'nein'),
  ('253', array['SH'], 'nein'),
  ('254', array['SH'], 'nein'),
  ('255', array['SH'], 'nein'),
  ('256', array['SH'], 'nein'),
  ('257', array['SH'], 'nein'),
  ('258', array['SH'], 'nein'),
  ('259', array['SH'], 'nein'),
  ('261', array['NI'], 'nein'),
  ('262', array['NI'], 'nein'),
  ('263', array['NI'], 'nein'),
  ('264', array['NI'], 'nein'),
  ('265', array['NI'], 'nein'),
  ('266', array['NI'], 'nein'),
  ('267', array['NI'], 'nein'),
  ('268', array['NI'], 'nein'),
  ('269', array['NI'], 'nein'),
  ('272', array['NI'], 'nein'),
  ('273', array['NI'], 'nein'),
  ('274', array['HH', 'NI', 'SH'], 'nein'),
  ('275', array['HB'], 'nein'),
  ('276', array['NI'], 'nein'),
  ('277', array['NI'], 'nein'),
  ('278', array['NI'], 'nein'),
  ('281', array['HB'], 'nein'),
  ('282', array['HB'], 'nein'),
  ('283', array['HB'], 'nein'),
  ('287', array['HB', 'NI'], 'nein'),
  ('288', array['NI'], 'nein'),
  ('292', array['NI'], 'nein'),
  ('293', array['NI'], 'nein'),
  ('294', array['NI', 'ST'], 'nein'),
  ('295', array['NI'], 'nein'),
  ('296', array['NI'], 'nein'),
  ('301', array['NI'], 'nein'),
  ('304', array['NI'], 'nein'),
  ('305', array['NI'], 'nein'),
  ('306', array['NI'], 'nein'),
  ('308', array['NI'], 'nein'),
  ('309', array['NI'], 'nein'),
  ('310', array['NI'], 'nein'),
  ('311', array['NI'], 'nein'),
  ('312', array['NI'], 'nein'),
  ('313', array['NI'], 'nein'),
  ('315', array['NI'], 'nein'),
  ('316', array['NI'], 'nein'),
  ('317', array['NI'], 'nein'),
  ('318', array['NI'], 'nein'),
  ('320', array['NW'], 'nein'),
  ('321', array['NW'], 'nein'),
  ('322', array['NW'], 'nein'),
  ('323', array['NW'], 'nein'),
  ('324', array['NW'], 'nein'),
  ('325', array['NW'], 'nein'),
  ('326', array['NW'], 'nein'),
  ('327', array['NW'], 'nein'),
  ('328', array['NW'], 'nein'),
  ('330', array['NW'], 'nein'),
  ('331', array['NW'], 'nein'),
  ('333', array['NW'], 'nein'),
  ('334', array['NW'], 'nein'),
  ('335', array['NW'], 'nein'),
  ('336', array['NW'], 'nein'),
  ('337', array['NW'], 'nein'),
  ('338', array['NW'], 'nein'),
  ('341', array['HE'], 'nein'),
  ('342', array['HE'], 'nein'),
  ('343', array['HE', 'NI'], 'nein'),
  ('344', array['HE', 'NW'], 'nein'),
  ('345', array['HE'], 'nein'),
  ('346', array['HE'], 'nein'),
  ('350', array['HE'], 'nein'),
  ('351', array['HE'], 'nein'),
  ('352', array['HE'], 'nein'),
  ('353', array['HE'], 'nein'),
  ('354', array['HE'], 'nein'),
  ('355', array['HE'], 'nein'),
  ('356', array['HE'], 'nein'),
  ('357', array['HE'], 'nein'),
  ('360', array['HE'], 'nein'),
  ('361', array['HE'], 'nein'),
  ('362', array['HE'], 'nein'),
  ('363', array['HE'], 'nein'),
  ('364', array['TH'], 'nein'),
  ('370', array['NI'], 'nein'),
  ('371', array['NI'], 'nein'),
  ('372', array['HE'], 'nein'),
  ('373', array['TH'], 'nein'),
  ('374', array['NI'], 'nein'),
  ('375', array['NI'], 'nein'),
  ('376', array['NI', 'NW'], 'nein'),
  ('380', array['NI'], 'nein'),
  ('381', array['NI'], 'nein'),
  ('382', array['NI'], 'nein'),
  ('383', array['NI'], 'nein'),
  ('384', array['NI', 'ST'], 'nein'),
  ('385', array['NI'], 'nein'),
  ('386', array['NI'], 'nein'),
  ('387', array['NI'], 'nein'),
  ('388', array['ST'], 'nein'),
  ('390', array['ST'], 'nein'),
  ('391', array['ST'], 'nein'),
  ('392', array['ST'], 'nein'),
  ('393', array['ST'], 'nein'),
  ('394', array['ST'], 'nein'),
  ('395', array['ST'], 'nein'),
  ('396', array['ST'], 'nein'),
  ('402', array['NW'], 'nein'),
  ('404', array['NW'], 'nein'),
  ('405', array['NW'], 'nein'),
  ('406', array['NW'], 'nein'),
  ('407', array['NW'], 'nein'),
  ('408', array['NW'], 'nein'),
  ('410', array['NW'], 'nein'),
  ('411', array['NW'], 'nein'),
  ('412', array['NW'], 'nein'),
  ('413', array['NW'], 'nein'),
  ('414', array['NW'], 'nein'),
  ('415', array['NW'], 'nein'),
  ('417', array['NW'], 'nein'),
  ('418', array['NW'], 'nein'),
  ('421', array['NW'], 'nein'),
  ('422', array['NW'], 'nein'),
  ('423', array['NW'], 'nein'),
  ('424', array['NW'], 'nein'),
  ('425', array['NW'], 'nein'),
  ('426', array['NW'], 'nein'),
  ('427', array['NW'], 'nein'),
  ('428', array['NW'], 'nein'),
  ('429', array['NW'], 'nein'),
  ('441', array['NW'], 'nein'),
  ('442', array['NW'], 'nein'),
  ('443', array['NW'], 'nein'),
  ('445', array['NW'], 'nein'),
  ('446', array['NW'], 'nein'),
  ('447', array['NW'], 'nein'),
  ('448', array['NW'], 'nein'),
  ('451', array['NW'], 'nein'),
  ('452', array['NW'], 'nein'),
  ('453', array['NW'], 'nein'),
  ('454', array['NW'], 'nein'),
  ('455', array['NW'], 'nein'),
  ('456', array['NW'], 'nein'),
  ('457', array['NW'], 'nein'),
  ('458', array['NW'], 'nein'),
  ('459', array['NW'], 'nein'),
  ('460', array['NW'], 'nein'),
  ('461', array['NW'], 'nein'),
  ('462', array['NW'], 'nein'),
  ('463', array['NW'], 'nein'),
  ('464', array['NW'], 'nein'),
  ('465', array['NW'], 'nein'),
  ('470', array['NW'], 'nein'),
  ('471', array['NW'], 'nein'),
  ('472', array['NW'], 'nein'),
  ('474', array['NW'], 'nein'),
  ('475', array['NW'], 'nein'),
  ('476', array['NW'], 'nein'),
  ('477', array['NW'], 'nein'),
  ('478', array['NW'], 'nein'),
  ('479', array['NW'], 'nein'),
  ('480', array['NW'], 'nein'),
  ('481', array['NW'], 'nein'),
  ('482', array['NW'], 'nein'),
  ('483', array['NW'], 'nein'),
  ('484', array['NI', 'NW'], 'nein'),
  ('485', array['NI', 'NW'], 'nein'),
  ('486', array['NW'], 'nein'),
  ('487', array['NW'], 'nein'),
  ('490', array['NI'], 'nein'),
  ('491', array['NI'], 'nein'),
  ('492', array['NI'], 'nein'),
  ('493', array['NI'], 'nein'),
  ('494', array['NI', 'NW'], 'nein'),
  ('495', array['NI', 'NW'], 'nein'),
  ('496', array['NI'], 'nein'),
  ('497', array['NI'], 'nein'),
  ('498', array['NI'], 'nein'),
  ('501', array['NW'], 'nein'),
  ('502', array['NW'], 'nein'),
  ('503', array['NW'], 'nein'),
  ('506', array['NW'], 'nein'),
  ('507', array['NW'], 'nein'),
  ('508', array['NW'], 'nein'),
  ('509', array['NW'], 'nein'),
  ('510', array['NW'], 'nein'),
  ('511', array['NW'], 'nein'),
  ('513', array['NW'], 'nein'),
  ('514', array['NW'], 'nein'),
  ('515', array['NW', 'RP'], 'nein'),
  ('516', array['NW'], 'nein'),
  ('517', array['NW'], 'nein'),
  ('520', array['NW'], 'nein'),
  ('521', array['NW'], 'nein'),
  ('522', array['NW'], 'nein'),
  ('523', array['NW'], 'nein'),
  ('524', array['NW'], 'nein'),
  ('525', array['NW'], 'nein'),
  ('531', array['NW'], 'nein'),
  ('532', array['NW'], 'nein'),
  ('533', array['NW'], 'nein'),
  ('534', array['RP'], 'nein'),
  ('535', array['RP'], 'nein'),
  ('536', array['NW', 'RP'], 'nein'),
  ('537', array['NW'], 'nein'),
  ('538', array['NW'], 'nein'),
  ('539', array['NW'], 'nein'),
  ('542', array['RP'], 'nein'),
  ('543', array['RP'], 'nein'),
  ('544', array['RP'], 'nein'),
  ('545', array['RP'], 'nein'),
  ('546', array['RP'], 'nein'),
  ('551', array['RP'], 'nein'),
  ('552', array['HE', 'RP'], 'nein'),
  ('554', array['RP'], 'nein'),
  ('555', array['RP'], 'nein'),
  ('556', array['RP'], 'nein'),
  ('557', array['RP'], 'nein'),
  ('560', array['RP'], 'nein'),
  ('561', array['RP'], 'nein'),
  ('562', array['RP'], 'nein'),
  ('563', array['RP'], 'nein'),
  ('564', array['RP'], 'nein'),
  ('565', array['RP'], 'nein'),
  ('566', array['RP'], 'nein'),
  ('567', array['RP'], 'nein'),
  ('568', array['RP'], 'nein'),
  ('570', array['NW'], 'nein'),
  ('572', array['NW'], 'nein'),
  ('573', array['NW'], 'nein'),
  ('574', array['NW'], 'nein'),
  ('575', array['RP'], 'nein'),
  ('576', array['RP'], 'nein'),
  ('580', array['NW'], 'nein'),
  ('581', array['NW'], 'nein'),
  ('582', array['NW'], 'nein'),
  ('583', array['NW'], 'nein'),
  ('584', array['NW'], 'nein'),
  ('585', array['NW'], 'nein'),
  ('586', array['NW'], 'nein'),
  ('587', array['NW'], 'nein'),
  ('588', array['NW'], 'nein'),
  ('590', array['NW'], 'nein'),
  ('591', array['NW'], 'nein'),
  ('592', array['NW'], 'nein'),
  ('593', array['NW'], 'nein'),
  ('594', array['NW'], 'nein'),
  ('595', array['NW'], 'nein'),
  ('596', array['NW'], 'nein'),
  ('597', array['NW'], 'nein'),
  ('598', array['NW'], 'nein'),
  ('599', array['HE', 'NW'], 'nein'),
  ('603', array['HE'], 'nein'),
  ('604', array['HE'], 'nein'),
  ('605', array['HE'], 'nein'),
  ('611', array['HE'], 'nein'),
  ('612', array['HE'], 'nein'),
  ('613', array['HE'], 'nein'),
  ('614', array['HE'], 'nein'),
  ('630', array['HE'], 'nein'),
  ('631', array['HE'], 'nein'),
  ('632', array['HE'], 'nein'),
  ('633', array['HE'], 'nein'),
  ('634', array['HE'], 'nein'),
  ('635', array['HE'], 'nein'),
  ('636', array['HE'], 'nein'),
  ('637', array['BY'], 'nein'),
  ('638', array['BY'], 'nein'),
  ('639', array['BY'], 'nein'),
  ('642', array['HE'], 'nein'),
  ('643', array['HE'], 'nein'),
  ('644', array['HE'], 'nein'),
  ('645', array['HE'], 'nein'),
  ('646', array['HE'], 'nein'),
  ('647', array['HE'], 'nein'),
  ('648', array['HE'], 'nein'),
  ('651', array['HE'], 'nein'),
  ('652', array['HE'], 'nein'),
  ('653', array['HE', 'RP'], 'nein'),
  ('654', array['HE'], 'nein'),
  ('655', array['HE', 'RP'], 'nein'),
  ('656', array['HE', 'RP'], 'nein'),
  ('657', array['HE'], 'nein'),
  ('658', array['HE'], 'nein'),
  ('659', array['HE'], 'nein'),
  ('661', array['SL'], 'nein'),
  ('662', array['SL'], 'nein'),
  ('663', array['SL'], 'nein'),
  ('664', array['RP', 'SL'], 'nein'),
  ('665', array['RP', 'SL'], 'nein'),
  ('666', array['SL'], 'nein'),
  ('667', array['SL'], 'nein'),
  ('668', array['RP', 'SL'], 'nein'),
  ('669', array['RP'], 'nein'),
  ('670', array['RP'], 'nein'),
  ('671', array['RP'], 'nein'),
  ('672', array['RP'], 'nein'),
  ('673', array['RP'], 'nein'),
  ('674', array['RP'], 'nein'),
  ('675', array['RP'], 'nein'),
  ('676', array['RP'], 'nein'),
  ('677', array['RP'], 'nein'),
  ('678', array['RP'], 'nein'),
  ('681', array['BW'], 'nein'),
  ('682', array['BW'], 'nein'),
  ('685', array['BW', 'HE'], 'nein'),
  ('686', array['HE'], 'nein'),
  ('687', array['BW'], 'nein'),
  ('688', array['BW'], 'nein'),
  ('691', array['BW'], 'nein'),
  ('692', array['BW', 'HE'], 'nein'),
  ('694', array['BW', 'HE'], 'nein'),
  ('695', array['BW', 'HE'], 'nein'),
  ('701', array['BW'], 'nein'),
  ('703', array['BW'], 'nein'),
  ('704', array['BW'], 'nein'),
  ('705', array['BW'], 'nein'),
  ('706', array['BW'], 'nein'),
  ('707', array['BW'], 'nein'),
  ('708', array['BW'], 'nein'),
  ('710', array['BW'], 'nein'),
  ('711', array['BW'], 'nein'),
  ('712', array['BW'], 'nein'),
  ('713', array['BW'], 'nein'),
  ('714', array['BW'], 'nein'),
  ('715', array['BW'], 'nein'),
  ('716', array['BW'], 'nein'),
  ('717', array['BW'], 'nein'),
  ('720', array['BW'], 'nein'),
  ('721', array['BW'], 'nein'),
  ('722', array['BW'], 'nein'),
  ('723', array['BW'], 'nein'),
  ('724', array['BW'], 'nein'),
  ('725', array['BW'], 'nein'),
  ('726', array['BW'], 'nein'),
  ('727', array['BW'], 'nein'),
  ('728', array['BW'], 'nein'),
  ('730', array['BW'], 'nein'),
  ('731', array['BW'], 'nein'),
  ('732', array['BW'], 'nein'),
  ('733', array['BW'], 'nein'),
  ('734', array['BW'], 'nein'),
  ('735', array['BW'], 'nein'),
  ('736', array['BW'], 'nein'),
  ('737', array['BW'], 'nein'),
  ('740', array['BW'], 'nein'),
  ('741', array['BW'], 'nein'),
  ('742', array['BW'], 'nein'),
  ('743', array['BW'], 'nein'),
  ('744', array['BW'], 'nein'),
  ('745', array['BW'], 'nein'),
  ('746', array['BW'], 'nein'),
  ('747', array['BW'], 'nein'),
  ('748', array['BW'], 'nein'),
  ('749', array['BW'], 'nein'),
  ('750', array['BW'], 'nein'),
  ('751', array['BW'], 'nein'),
  ('752', array['BW'], 'nein'),
  ('753', array['BW'], 'nein'),
  ('754', array['BW'], 'nein'),
  ('760', array['BW'], 'nein'),
  ('761', array['BW'], 'nein'),
  ('762', array['BW'], 'nein'),
  ('763', array['BW'], 'nein'),
  ('764', array['BW'], 'nein'),
  ('765', array['BW'], 'nein'),
  ('766', array['BW'], 'nein'),
  ('767', array['BW', 'RP'], 'nein'),
  ('768', array['RP'], 'nein'),
  ('776', array['BW'], 'nein'),
  ('777', array['BW'], 'nein'),
  ('778', array['BW'], 'nein'),
  ('779', array['BW'], 'nein'),
  ('780', array['BW'], 'nein'),
  ('781', array['BW'], 'nein'),
  ('782', array['BW'], 'nein'),
  ('783', array['BW'], 'nein'),
  ('784', array['BW'], 'nein'),
  ('785', array['BW'], 'nein'),
  ('786', array['BW'], 'nein'),
  ('787', array['BW'], 'nein'),
  ('790', array['BW'], 'nein'),
  ('791', array['BW'], 'nein'),
  ('792', array['BW'], 'nein'),
  ('793', array['BW'], 'nein'),
  ('794', array['BW'], 'nein'),
  ('795', array['BW'], 'nein'),
  ('796', array['BW'], 'nein'),
  ('797', array['BW'], 'nein'),
  ('798', array['BW'], 'nein'),
  ('803', array['BY'], 'nein'),
  ('804', array['BY'], 'nein'),
  ('805', array['BY'], 'nein'),
  ('806', array['BY'], 'nein'),
  ('807', array['BY'], 'nein'),
  ('808', array['BY'], 'nein'),
  ('809', array['BY'], 'nein'),
  ('812', array['BY'], 'nein'),
  ('813', array['BY'], 'nein'),
  ('814', array['BY'], 'nein'),
  ('815', array['BY'], 'nein'),
  ('816', array['BY'], 'nein'),
  ('817', array['BY'], 'nein'),
  ('818', array['BY'], 'nein'),
  ('819', array['BY'], 'nein'),
  ('820', array['BY'], 'nein'),
  ('821', array['BY'], 'nein'),
  ('822', array['BY'], 'nein'),
  ('823', array['BY'], 'nein'),
  ('824', array['BY'], 'nein'),
  ('825', array['BY'], 'nein'),
  ('830', array['BY'], 'nein'),
  ('831', array['BY'], 'nein'),
  ('832', array['BY'], 'nein'),
  ('833', array['BY'], 'nein'),
  ('834', array['BY'], 'nein'),
  ('835', array['BY'], 'nein'),
  ('836', array['BY'], 'nein'),
  ('837', array['BY'], 'nein'),
  ('840', array['BY'], 'nein'),
  ('841', array['BY'], 'nein'),
  ('843', array['BY'], 'nein'),
  ('844', array['BY'], 'nein'),
  ('845', array['BY'], 'nein'),
  ('850', array['BY'], 'nein'),
  ('851', array['BY'], 'nein'),
  ('852', array['BY'], 'nein'),
  ('853', array['BY'], 'nein'),
  ('854', array['BY'], 'nein'),
  ('855', array['BY'], 'nein'),
  ('856', array['BY'], 'nein'),
  ('857', array['BY'], 'nein'),
  ('861', array['BY'], 'ja'),
  ('863', array['BY'], 'nein'),
  ('864', array['BY'], 'nein'),
  ('865', array['BY'], 'nein'),
  ('866', array['BY'], 'nein'),
  ('867', array['BY'], 'nein'),
  ('868', array['BY'], 'nein'),
  ('869', array['BY'], 'nein'),
  ('874', array['BY'], 'nein'),
  ('875', array['BY'], 'nein'),
  ('876', array['BY'], 'nein'),
  ('877', array['BY'], 'nein'),
  ('880', array['BW'], 'nein'),
  ('881', array['BW', 'BY'], 'nein'),
  ('882', array['BW'], 'nein'),
  ('883', array['BW'], 'nein'),
  ('884', array['BW'], 'nein'),
  ('885', array['BW'], 'nein'),
  ('886', array['BW'], 'nein'),
  ('887', array['BW'], 'nein'),
  ('890', array['BW'], 'nein'),
  ('891', array['BW'], 'nein'),
  ('892', array['BY'], 'nein'),
  ('893', array['BY'], 'nein'),
  ('894', array['BY'], 'nein'),
  ('895', array['BW'], 'nein'),
  ('896', array['BW'], 'nein'),
  ('904', array['BY'], 'nein'),
  ('905', array['BY'], 'nein'),
  ('906', array['BY'], 'nein'),
  ('907', array['BY'], 'nein'),
  ('910', array['BY'], 'nein'),
  ('911', array['BY'], 'nein'),
  ('912', array['BY'], 'nein'),
  ('913', array['BY'], 'nein'),
  ('914', array['BY'], 'nein'),
  ('915', array['BY'], 'nein'),
  ('916', array['BY'], 'nein'),
  ('917', array['BY'], 'nein'),
  ('918', array['BY'], 'nein'),
  ('922', array['BY'], 'nein'),
  ('923', array['BY'], 'nein'),
  ('924', array['BY'], 'nein'),
  ('925', array['BY'], 'nein'),
  ('926', array['BY'], 'nein'),
  ('927', array['BY'], 'nein'),
  ('930', array['BY'], 'nein'),
  ('931', array['BY'], 'nein'),
  ('933', array['BY'], 'nein'),
  ('934', array['BY'], 'nein'),
  ('940', array['BY'], 'nein'),
  ('941', array['BY'], 'nein'),
  ('942', array['BY'], 'nein'),
  ('943', array['BY'], 'nein'),
  ('944', array['BY'], 'nein'),
  ('945', array['BY'], 'nein'),
  ('950', array['BY'], 'nein'),
  ('951', array['BY'], 'nein'),
  ('952', array['BY'], 'nein'),
  ('953', array['BY'], 'nein'),
  ('954', array['BY'], 'nein'),
  ('955', array['BY'], 'nein'),
  ('956', array['BY'], 'nein'),
  ('957', array['BY'], 'nein'),
  ('960', array['BY'], 'nein'),
  ('961', array['BY'], 'nein'),
  ('962', array['BY'], 'nein'),
  ('963', array['BY'], 'nein'),
  ('964', array['BY'], 'nein'),
  ('965', array['TH'], 'nein'),
  ('970', array['BY'], 'nein'),
  ('971', array['BY'], 'nein'),
  ('972', array['BY'], 'nein'),
  ('973', array['BY'], 'nein'),
  ('974', array['BY'], 'nein'),
  ('975', array['BY'], 'nein'),
  ('976', array['BY'], 'nein'),
  ('977', array['BY'], 'nein'),
  ('978', array['BW', 'BY'], 'nein'),
  ('979', array['BW', 'BY'], 'nein'),
  ('985', array['TH'], 'nein'),
  ('986', array['TH'], 'nein'),
  ('987', array['TH'], 'nein'),
  ('990', array['TH'], 'nein'),
  ('991', array['TH'], 'nein'),
  ('993', array['TH'], 'nein'),
  ('994', array['TH'], 'nein'),
  ('995', array['TH'], 'nein'),
  ('996', array['TH'], 'nein'),
  ('997', array['TH'], 'nein'),
  ('998', array['TH'], 'nein'),
  ('999', array['TH'], 'nein');

/* Ostersonntag (gregorianisch, Meeus/Jones/Butcher) -- wie easterSunday im Client. */
create or replace function public.workspace_osterdatum(p_jahr integer)
returns date
language plpgsql
immutable
set search_path = public
as $$
declare
  a integer := p_jahr % 19;
  b integer := p_jahr / 100;
  c integer := p_jahr % 100;
  d integer;
  e integer;
  f integer;
  g integer;
  h integer;
  i integer;
  k integer;
  l integer;
  m integer;
begin
  d := b / 4;
  e := b % 4;
  f := (b + 8) / 25;
  g := (b - f + 1) / 3;
  h := (19 * a + b - d - g + 15) % 30;
  i := c / 4;
  k := c % 4;
  l := (32 + 2 * e + 2 * i - h - k) % 7;
  m := (a + 11 * h + 22 * l) / 451;
  return make_date(p_jahr, (h + l - 7 * m + 114) / 31, ((h + l - 7 * m + 114) % 31) + 1);
end;
$$;

revoke all on function public.workspace_osterdatum(integer) from public, anon, authenticated, service_role;

/*
 * Der gesetzliche Feiertag an p_tag im Land p_land: 'feiertag', 'kein' oder 'gemeinde:<art>' fuer einen
 * Feiertag, der nur in einzelnen Gemeinden gilt (fronleichnam in SN/TH, mariaeHimmelfahrt und
 * augsburgerFriedensfest in BY). Wie feiertagImLand im Client, mit denselben Stichtagen.
 */
create or replace function public.workspace_feiertag_im_land(p_tag date, p_land text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_jahr integer := extract(year from p_tag)::integer;
  v_md text := to_char(p_tag, 'MM-DD');
  v_ostern date := public.workspace_osterdatum(extract(year from p_tag)::integer);
  v_bub date;
begin
  if v_md = '01-01' then return 'feiertag'; end if;
  if v_md = '01-06' and p_land = any (array['BW', 'BY', 'ST']) then return 'feiertag'; end if;
  if v_md = '03-08' and ((p_land = 'BE' and v_jahr >= 2019) or (p_land = 'MV' and v_jahr >= 2023)) then
    return 'feiertag';
  end if;
  if p_tag = v_ostern - 2 or p_tag = v_ostern + 1 then return 'feiertag'; end if;
  if v_md = '05-01' then return 'feiertag'; end if;
  if v_md = '05-08' and v_jahr in (2020, 2025) and p_land = 'BE' then return 'feiertag'; end if;
  if p_tag = v_ostern + 39 or p_tag = v_ostern + 50 then return 'feiertag'; end if;
  if p_tag = v_ostern + 60 then
    if p_land = any (array['BW', 'BY', 'HE', 'NW', 'RP', 'SL']) then return 'feiertag'; end if;
    if p_land in ('SN', 'TH') then return 'gemeinde:fronleichnam'; end if;
  end if;
  if v_md = '08-08' and p_land = 'BY' then return 'gemeinde:augsburgerFriedensfest'; end if;
  if v_md = '08-15' then
    if p_land = 'SL' then return 'feiertag'; end if;
    if p_land = 'BY' then return 'gemeinde:mariaeHimmelfahrt'; end if;
  end if;
  if v_md = '09-20' and v_jahr >= 2019 and p_land = 'TH' then return 'feiertag'; end if;
  if v_md = '10-03' and v_jahr >= 1990 then return 'feiertag'; end if;
  if v_md = '10-31' then
    if v_jahr = 2017 then return 'feiertag'; end if;
    if p_land = any (array['BB', 'MV', 'SN', 'ST', 'TH']) then return 'feiertag'; end if;
    if v_jahr >= 2018 and p_land = any (array['HB', 'HH', 'NI', 'SH']) then return 'feiertag'; end if;
  end if;
  if v_md = '11-01' and p_land = any (array['BW', 'BY', 'NW', 'RP', 'SL']) then return 'feiertag'; end if;
  /* Buss- und Bettag: der Mittwoch vor dem 23. November. */
  v_bub := make_date(v_jahr, 11, 22) - ((extract(dow from make_date(v_jahr, 11, 22))::integer - 3 + 7) % 7);
  if p_tag = v_bub and p_land = 'SN' then return 'feiertag'; end if;
  if v_md in ('12-25', '12-26') then return 'feiertag'; end if;
  return 'kein';
end;
$$;

revoke all on function public.workspace_feiertag_im_land(date, text) from public, anon, authenticated, service_role;

/*
 * Laender einer fuenfstelligen PLZ: dreistelliger Leitbereich, sonst Obermenge der Leitregion (zwei
 * Stellen), sonst NULL. Wie laenderFuerPlz im Client.
 */
create or replace function public.workspace_laender_fuer_plz(p_zip text)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_laender text[];
  v_augsburg text;
  v_moeglich boolean;
begin
  if p_zip is null or p_zip !~ '^[0-9]{5}$' then return null; end if;
  select b.laender, b.augsburg into v_laender, v_augsburg
  from public.workspace_plz_leitbereiche b
  where b.leitbereich = substr(p_zip, 1, 3);
  if found then
    return jsonb_build_object('laender', to_jsonb(v_laender), 'augsburg', v_augsburg);
  end if;
  select array_agg(distinct l order by l), bool_or(b.augsburg <> 'nein')
    into v_laender, v_moeglich
  from public.workspace_plz_leitbereiche b
  cross join lateral unnest(b.laender) l
  where b.leitbereich like substr(p_zip, 1, 2) || '%';
  if v_laender is null then return null; end if;
  return jsonb_build_object('laender', to_jsonb(v_laender), 'augsburg', case when v_moeglich then 'teils' else 'nein' end);
end;
$$;

revoke all on function public.workspace_laender_fuer_plz(text) from public, anon, authenticated, service_role;

/*
 * Status eines Tages fuer eine Lage im Inland: 'frei' (Sa/So oder in allen moeglichen Laendern Feiertag),
 * 'werktag' (in keinem) oder 'unklar'. Gemeindefeiertage entscheidet nur eine Angabe in lage.gemeinde.
 */
create or replace function public.workspace_frist_tagstatus(p_tag date, p_lage jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_land text;
  v_feiertag text;
  v_angabe jsonb;
  v_ja integer := 0;
  v_nein integer := 0;
begin
  if extract(isodow from p_tag) in (6, 7) then return 'frei'; end if;
  for v_land in select jsonb_array_elements_text(coalesce(p_lage->'laender', '[]'::jsonb)) loop
    v_feiertag := public.workspace_feiertag_im_land(p_tag, v_land);
    if v_feiertag = 'kein' then
      v_nein := v_nein + 1;
    elsif v_feiertag = 'feiertag' then
      v_ja := v_ja + 1;
    else
      v_angabe := p_lage->'gemeinde'->substr(v_feiertag, length('gemeinde:') + 1);
      if v_angabe = 'true'::jsonb then
        v_ja := v_ja + 1;
      elsif v_angabe = 'false'::jsonb then
        v_nein := v_nein + 1;
      else
        return 'unklar';
      end if;
    end if;
    if v_ja > 0 and v_nein > 0 then return 'unklar'; end if;
  end loop;
  return case when v_ja > 0 then 'frei' else 'werktag' end;
end;
$$;

revoke all on function public.workspace_frist_tagstatus(date, jsonb) from public, anon, authenticated, service_role;

/*
 * Jedes moegliche wirksame Fristende liegt in [fruehestens, spaetestens]. Wie berechneFristFenster im
 * Client: abbedungen -> kalendarisch; ausland -> Sa/So verschoben, ohne Bestaetigung drei Werktage
 * ungeklaert; inland -> ueber freie Tage (fruehestens) bzw. freie und unklare Tage (spaetestens).
 */
create or replace function public.workspace_fristfenster(
  p_ende date,
  p_lage jsonb,
  out fruehestens date,
  out spaetestens date
)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_i integer;
  v_werktage integer;
begin
  if p_lage->>'art' = 'abbedungen' then
    fruehestens := p_ende;
    spaetestens := p_ende;
    return;
  end if;
  if p_lage->>'art' = 'ausland' then
    fruehestens := p_ende;
    v_i := 0;
    while v_i < 40 and extract(isodow from fruehestens) in (6, 7) loop
      fruehestens := fruehestens + 1;
      v_i := v_i + 1;
    end loop;
    spaetestens := fruehestens;
    if coalesce(p_lage->'ohneFeiertagBestaetigt' = 'true'::jsonb, false) is false then
      v_werktage := 0;
      v_i := 0;
      while v_werktage < 3 and v_i < 40 loop
        spaetestens := spaetestens + 1;
        v_i := v_i + 1;
        if extract(isodow from spaetestens) not in (6, 7) then v_werktage := v_werktage + 1; end if;
      end loop;
    end if;
    return;
  end if;
  fruehestens := p_ende;
  v_i := 0;
  while v_i < 40 and public.workspace_frist_tagstatus(fruehestens, p_lage) = 'frei' loop
    fruehestens := fruehestens + 1;
    v_i := v_i + 1;
  end loop;
  spaetestens := p_ende;
  v_i := 0;
  while v_i < 40 and public.workspace_frist_tagstatus(spaetestens, p_lage) <> 'werktag' loop
    spaetestens := spaetestens + 1;
    v_i := v_i + 1;
  end loop;
end;
$$;

revoke all on function public.workspace_fristfenster(date, jsonb) from public, anon, authenticated, service_role;

/*
 * Die Lage einer Rechnung (Payload aus workspace_invoices): Vereinbarung -> Angabe am Kunden
 * (payload.customerId, nicht geloescht) -> Land/PLZ der Rechnungsanschrift -> unbekannt. Wie
 * ermittleFristLage/invoiceFristLage im Client.
 */
create or replace function public.workspace_invoice_frist_lage(p_workspace_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_kunde text;
  v_ort jsonb;
  v_region text;
  v_gemeinde jsonb := '{}'::jsonb;
  v_land text;
  v_zip text;
  v_plz jsonb;
begin
  if p_payload->'deadlineShiftWaived' = 'true'::jsonb then
    return jsonb_build_object('art', 'abbedungen');
  end if;

  v_kunde := nullif(btrim(coalesce(p_payload->>'customerId', '')), '');
  if v_kunde is not null then
    select c.payload->'holidayLocation' into v_ort
    from public.workspace_customers c
    where c.workspace_id = p_workspace_id
      and c.customer_id = v_kunde
      and not c.deleted;
    if jsonb_typeof(v_ort) = 'object' then
      v_region := v_ort->>'region';
      if v_region = 'AUSLAND' then
        return jsonb_build_object(
          'art', 'ausland',
          'ohneFeiertagBestaetigt', coalesce(v_ort->'auslandOhneFeiertag' = 'true'::jsonb, false),
          'quelle', 'kunde'
        );
      end if;
      if v_region = any (array['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH']) then
        if v_region in ('SN', 'TH') and jsonb_typeof(v_ort->'fronleichnam') = 'boolean' then
          v_gemeinde := v_gemeinde || jsonb_build_object('fronleichnam', v_ort->'fronleichnam');
        end if;
        if v_region = 'BY' then
          if jsonb_typeof(v_ort->'mariaeHimmelfahrt') = 'boolean' then
            v_gemeinde := v_gemeinde || jsonb_build_object('mariaeHimmelfahrt', v_ort->'mariaeHimmelfahrt');
          end if;
          if jsonb_typeof(v_ort->'augsburgerFriedensfest') = 'boolean' then
            v_gemeinde := v_gemeinde || jsonb_build_object('augsburgerFriedensfest', v_ort->'augsburgerFriedensfest');
          end if;
        end if;
        return jsonb_build_object('art', 'inland', 'laender', jsonb_build_array(v_region), 'gemeinde', v_gemeinde, 'quelle', 'kunde');
      end if;
    end if;
  end if;

  v_land := upper(btrim(coalesce(p_payload->'customerSnapshot'->>'countryCode', '')));
  if v_land <> '' and v_land <> 'DE' then
    return jsonb_build_object('art', 'ausland', 'ohneFeiertagBestaetigt', false, 'quelle', 'land');
  end if;
  v_zip := btrim(coalesce(p_payload->'customerSnapshot'->>'zip', ''));
  /* Deutsche PLZ, Leistungsort in Oesterreich: Jungholz und das Kleinwalsertal. */
  if v_zip in ('87491', '87567', '87568', '87569') then
    return jsonb_build_object('art', 'ausland', 'ohneFeiertagBestaetigt', false, 'quelle', 'plz');
  end if;
  v_plz := public.workspace_laender_fuer_plz(v_zip);
  if v_plz is not null then
    v_gemeinde := case v_plz->>'augsburg'
      when 'ja' then jsonb_build_object('augsburgerFriedensfest', true)
      when 'nein' then jsonb_build_object('augsburgerFriedensfest', false)
      else '{}'::jsonb
    end;
    return jsonb_build_object('art', 'inland', 'laender', v_plz->'laender', 'gemeinde', v_gemeinde, 'quelle', 'plz');
  end if;
  return jsonb_build_object(
    'art', 'inland',
    'laender', to_jsonb(array['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH']),
    'gemeinde', '{}'::jsonb,
    'quelle', 'unbekannt'
  );
end;
$$;

revoke all on function public.workspace_invoice_frist_lage(uuid, jsonb) from public, anon, authenticated, service_role;

/*
 * Wie 20261117, das Skonto-Fristende jetzt nach Paragraf 193 BGB am Sitz des Kunden:
 *  - bis zum fruehestmoeglichen Ende mindestens der Betrag nach Skonto gezahlt -> 0 offen;
 *  - erst bis zum spaetestmoeglichen -> invoice_skonto_deadline_unclear (keine Entscheidung);
 *  - sonst Betrag minus Zahlungen.
 * NULL, wenn die Rechnung fehlt oder keinen Betrag traegt. Ohne eigene Sperre: Die Aufrufer halten die
 * Sperre der Rechnung (und des Vorgangs).
 */
create or replace function public.workspace_invoice_open_cents(
  p_workspace_id uuid,
  p_client_invoice_id text
)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_payload jsonb;
  v_total numeric;
  v_paid numeric;
  v_pct numeric;
  v_days integer;
  v_basis date;
  v_fenster record;
  v_payable numeric;
  v_bis_frueh numeric;
  v_bis_spaet numeric;
begin
  select wi.payload, round((wi.payload->>'amount')::numeric * 100)
    into v_payload, v_total
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = p_client_invoice_id
    and jsonb_typeof(wi.payload->'amount') = 'number';
  if v_payload is null then return null; end if;

  select coalesce(sum(round(p.amount * 100)), 0) into v_paid
  from public.workspace_invoice_payments p
  where p.workspace_id = p_workspace_id
    and p.client_invoice_id = p_client_invoice_id
    and p.reversed_at is null;
  if v_paid >= v_total then return 0; end if;

  select s.pct, s.days into v_pct, v_days from public.workspace_skonto_terms(v_payload->>'skontoText') s;
  v_basis := public.workspace_safe_date(
    case when jsonb_typeof(v_payload->'issueDate') = 'string' then v_payload->>'issueDate' else v_payload->>'date' end
  );
  if v_pct is null or v_pct <= 0 or v_pct >= 100 or v_days is null or v_basis is null then
    return v_total - v_paid;
  end if;

  select * into v_fenster
  from public.workspace_fristfenster(v_basis + v_days, public.workspace_invoice_frist_lage(p_workspace_id, v_payload));
  v_payable := round(v_total * (100 - v_pct) / 100);

  select coalesce(sum(round(p.amount * 100)) filter (where p.paid_on <= v_fenster.fruehestens), 0),
         coalesce(sum(round(p.amount * 100)) filter (where p.paid_on <= v_fenster.spaetestens), 0)
    into v_bis_frueh, v_bis_spaet
  from public.workspace_invoice_payments p
  where p.workspace_id = p_workspace_id
    and p.client_invoice_id = p_client_invoice_id
    and p.reversed_at is null;

  if v_bis_frueh + 1 >= v_payable then return 0; end if;
  if v_bis_spaet + 1 >= v_payable then
    raise exception 'invoice_skonto_deadline_unclear: Frist % bis %', v_fenster.fruehestens, v_fenster.spaetestens
      using errcode = 'P0001';
  end if;
  return v_total - v_paid;
end;
$$;

revoke all on function public.workspace_invoice_open_cents(uuid, text) from public, anon, authenticated, service_role;
