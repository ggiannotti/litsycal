// Pure-gjs tests for the Shell-independent parsers (quickAddParser.js and
// timeInput.js). Run with: gjs -m tests/test-quickadd-time.js
// Prints PASS/FAIL per check and exits non-zero if any check fails.

import System from 'system';

import {parseQuickAdd} from '../quickAddParser.js';
import {toHHMM, fromHHMM, formatTime, parseTimeInput} from '../timeInput.js';

let failures = 0;
let total = 0;

const check = (label, actual, expected) => {
    total++;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok)
        failures++;
    print(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

// parseQuickAdd: valid times are still extracted.
check('quickadd 15:30 time', parseQuickAdd('Dentist 15:30')?.time, '15:30');
check('quickadd 15:30 title', parseQuickAdd('Dentist 15:30')?.title, 'Dentist');
check('quickadd 3:30pm time', parseQuickAdd('Dentist 3:30pm')?.time, '15:30');
check('quickadd 3pm time', parseQuickAdd('Dentist 3pm')?.time, '15:00');
check('quickadd at 3 time', parseQuickAdd('Lunch at 3')?.time, '03:00');
check('quickadd at 3 title', parseQuickAdd('Lunch at 3')?.title, 'Lunch');

// parseQuickAdd: invalid times must not be extracted (regression: "99:99"
// used to become a bogus time instead of staying in the title).
check('quickadd 99:99 time', parseQuickAdd('Lunch 99:99')?.time, null);
check('quickadd 99:99 title', parseQuickAdd('Lunch 99:99')?.title, 'Lunch 99:99');
check('quickadd 99:30 time', parseQuickAdd('Lunch 99:30')?.time, null);
check('quickadd 99:30 title', parseQuickAdd('Lunch 99:30')?.title, 'Lunch 99:30');
check('quickadd 25:30 time', parseQuickAdd('Lunch 25:30')?.time, null);
check('quickadd 13pm time', parseQuickAdd('Party 13pm')?.time, null);
check('quickadd 13pm title', parseQuickAdd('Party 13pm')?.title, 'Party 13pm');
check('quickadd at 99 time', parseQuickAdd('Lunch at 99')?.time, null);
check('quickadd at 99:99 time', parseQuickAdd('Lunch at 99:99')?.time, null);
check('quickadd 23h60 time', parseQuickAdd('Meeting 23h60')?.time, null);
check('quickadd 15h30 time', parseQuickAdd('Meeting 15h30')?.time, '15:30');
check('quickadd invalid-then-valid colon time', parseQuickAdd('Lunch 99:99 15:30')?.time, '15:30');
check('quickadd invalid-then-valid ampm time', parseQuickAdd('Party 13pm 3pm')?.time, '15:00');
check('quickadd invalid-then-valid h time', parseQuickAdd('Meeting 12h60 14h30')?.time, '14:30');
check('quickadd at 99 location', parseQuickAdd('Lunch at 99')?.location, null);
check('quickadd at 13pm location', parseQuickAdd('Lunch at 13pm')?.location, null);
check('quickadd at 23h60 location', parseQuickAdd('Lunch at 23h60')?.location, null);
check('quickadd at 123pm location', parseQuickAdd('Lunch at 123pm')?.location, null);
check('quickadd at 13pm! location', parseQuickAdd('Lunch at 13pm!')?.location, null);
check('quickadd at 9.30am location', parseQuickAdd('Call at 9.30am')?.location, null);
check('quickadd at 6.45 location', parseQuickAdd('Flight at 6.45')?.location, null);
check('quickadd at 5-6pm location', parseQuickAdd('Meet at 5-6pm')?.location, null);
check('quickadd at 7-Eleven time', parseQuickAdd('Coffee at 7-Eleven')?.time, null);
check('quickadd at 7-Eleven title', parseQuickAdd('Coffee at 7-Eleven')?.title, 'Coffee');
check('quickadd at 7-Eleven location', parseQuickAdd('Coffee at 7-Eleven')?.location, '7-Eleven');
check('quickadd at 8.30 time', parseQuickAdd('Dinner at 8.30')?.time, '08:30');
check('quickadd 9.30 time', parseQuickAdd('Dentist 9.30')?.time, '09:30');
check('quickadd 9.30 title', parseQuickAdd('Dentist 9.30')?.title, 'Dentist');
check('quickadd 9.30am time', parseQuickAdd('Call 9.30am')?.time, '09:30');
check('quickadd 9.30am title', parseQuickAdd('Call 9.30am')?.title, 'Call');
check('quickadd range 3-4pm time', parseQuickAdd('meet 3-4pm')?.time, '16:00');
check('quickadd range 3-4pm title', parseQuickAdd('meet 3-4pm')?.title, 'meet');
check('quickadd range 3-4:30pm time', parseQuickAdd('meet 3-4:30pm')?.time, '16:30');
check('quickadd range 3-4:30pm title', parseQuickAdd('meet 3-4:30pm')?.title, 'meet');
check('quickadd range en-dash time', parseQuickAdd('meet 3–4pm')?.time, '16:00');
check('quickadd range en-dash title', parseQuickAdd('meet 3–4pm')?.title, 'meet');
check('quickadd at 3. time', parseQuickAdd('Lunch at 3.')?.time, '03:00');
check('quickadd at 13pm) location', parseQuickAdd('Lunch at 13pm)')?.location, null);
check('quickadd Timer 12:30:45 time', parseQuickAdd('Timer 12:30:45')?.time, '12:30');
check('quickadd Timer 12:30:45 title', parseQuickAdd('Timer 12:30:45')?.title, 'Timer');
check('quickadd at Cafe Nero! location', parseQuickAdd('Lunch at Cafe Nero!')?.location, 'Cafe Nero!');
check('quickadd at 13:30pm time', parseQuickAdd('Lunch at 13:30pm')?.time, null);
check('quickadd at 13:30pm title', parseQuickAdd('Lunch at 13:30pm')?.title, 'Lunch at 13:30pm');
check('quickadd bare number kept', parseQuickAdd('Room 5 cleanup')?.title, 'Room 5 cleanup');
check('quickadd bare number time', parseQuickAdd('Room 5 cleanup')?.time, null);
check('quickadd empty', parseQuickAdd('   '), null);

// timeInput: toHHMM / fromHHMM / formatTime.
check('toHHMM 0', toHHMM(0), '00:00');
check('toHHMM 570', toHHMM(570), '09:30');
check('toHHMM 1439', toHHMM(1439), '23:59');
check('fromHHMM 9:30', fromHHMM('9:30'), 570);
check('fromHHMM 23:59', fromHHMM('23:59'), 1439);
check('fromHHMM 24:00', fromHHMM('24:00'), null);
check('fromHHMM 9:60', fromHHMM('9:60'), null);
check('fromHHMM junk', fromHHMM('junk'), null);
check('formatTime 24h', formatTime(930, '24h'), '15:30');
check('formatTime 12h pm', formatTime(930, '12h'), '3:30pm');
check('formatTime 12h midnight', formatTime(0, '12h'), '12:00am');

// timeInput: parseTimeInput.
check('parseTimeInput 9:30', parseTimeInput('9:30'), 570);
check('parseTimeInput 9:30pm', parseTimeInput('9:30pm'), 1290);
check('parseTimeInput 21:30', parseTimeInput('21:30'), 1290);
check('parseTimeInput 930', parseTimeInput('930'), 570);
check('parseTimeInput 99:99', parseTimeInput('99:99'), null);
check('parseTimeInput 24:00', parseTimeInput('24:00'), null);
check('parseTimeInput 13pm', parseTimeInput('13pm'), null);
check('parseTimeInput empty', parseTimeInput(''), null);

print(`${total - failures}/${total} checks passed`);
if (failures > 0)
    System.exit(1);
