// #region 1: DATABASE & INITIALIZATION
let db;
const DB_NAME = "HabitTrackerDB";
const DB_VERSION = 5;
const TASK_STORE = "tasks";
const META_STORE = "metadata";

const request = indexedDB.open(DB_NAME, DB_VERSION);

// --- PROMISE WRAPPERS FOR INDEXEDDB ---
function dbGet(store, key, defaultValue = null) {
    return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result !== undefined ? req.result : defaultValue);
        req.onerror = () => reject(req.error);
    });
}

function dbGetAll(store) {
    return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

request.onupgradeneeded = (e) => {
    db = e.target.result;
    if (db.objectStoreNames.contains("habits")) db.deleteObjectStore("habits");
    if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    if (!db.objectStoreNames.contains(TASK_STORE)) db.createObjectStore(TASK_STORE, { keyPath: "id", autoIncrement: true });
};

request.onsuccess = (e) => {
    db = e.target.result;
    // Check for passive recharge BEFORE loading the board!
    handleRecharge(() => {
        refreshTasks();
    });
};

// #endregion

// #region 2: RPG ENGINE & ECONOMY

// Passive Recharge Logic
function handleRecharge(callback) {
    const transaction = db.transaction([META_STORE], "readwrite");
    const metaStore = transaction.objectStore(META_STORE);

    metaStore.get("lastFreezeRecharge").onsuccess = (e) => {
        let lastRecharge = e.target.result;
        const now = Date.now();
        const interval = 30 * 24 * 60 * 60 * 1000;

        if (!lastRecharge) {
            metaStore.put(now, "lastFreezeRecharge");
            return callback();
        }

        const timePassed = now - lastRecharge;
        if (timePassed >= interval) {
            const cycles = Math.floor(timePassed / interval);

            metaStore.get("globalFreezes").onsuccess = (e2) => {
                let freezes = e2.target.result || 0;
                // Fetch the TRUE max (5 if veteran, else 2)
                metaStore.get("trueMaxFreezes").onsuccess = (e3) => {
                    let trueMax = e3.target.result || 2;

                    let newFreezes = Math.min(trueMax, freezes + cycles);
                    let added = newFreezes - freezes;

                    if (added > 0) showToast(`❄️ Passive Income! Recharged ${added} Freeze(s) in your stash.`);

                    metaStore.put(newFreezes, "globalFreezes");
                    metaStore.put(lastRecharge + (cycles * interval), "lastFreezeRecharge");
                    callback();
                };
            };
        } else {
            callback();
        }
    };
}

// GLOBAL SHOP & FREEZES
function buyGlobalFreeze() {
    const transaction = db.transaction([META_STORE], "readwrite");
    const metaStore = transaction.objectStore(META_STORE);

    metaStore.get("gems").onsuccess = (e) => {
        let gems = e.target.result || 0;
        metaStore.get("globalFreezes").onsuccess = (e2) => {
            let freezes = e2.target.result || 0;
            metaStore.get("trueMaxFreezes").onsuccess = (e3) => {
                let trueMax = e3.target.result || 2;

                if (gems < 30) return showToast("Not enough gems! (Needs 30💎)");
                // Shop checks the HIDDEN stash capacity, not the UI capacity!
                if (freezes >= trueMax) return showToast("Your hidden stash is already full!");

                gems -= 30;
                freezes += 1;

                metaStore.put(gems, "gems");
                metaStore.put(freezes, "globalFreezes");

                transaction.oncomplete = () => {
                    refreshTasks(); // Update UI to reflect purchase
                    showToast("-30 💎. Global Freeze added to stash!");
                };
            };
        };
    };
}

// DAILY CHEST MECHANIC
function openChest() {
    const transaction = db.transaction([META_STORE], "readwrite");
    const metaStore = transaction.objectStore(META_STORE);

    metaStore.get("gems").onsuccess = (eGems) => {
        let gems = eGems.target.result || 0;
        metaStore.get("lastChestOpenDate").onsuccess = (eOpen) => {
            let lastChestOpenDate = eOpen.target.result || 0;
            metaStore.get("chestCombo").onsuccess = (eCombo) => {
                let chestCombo = eCombo.target.result || 0;
                metaStore.get("yearBadgeEnabled").onsuccess = (eBadge) => {
                    let yearBadgeEnabled = eBadge.target.result || false;

                    const now = Date.now();
                    const today = new Date(now).setHours(0, 0, 0, 0);
                    const lastOpenDay = new Date(lastChestOpenDate).setHours(0, 0, 0, 0);

                    if (lastChestOpenDate !== 0 && today <= lastOpenDay) return;

                    const oneDay = 24 * 60 * 60 * 1000;
                    if (lastChestOpenDate !== 0 && (today - lastOpenDay > oneDay)) chestCombo = 0;

                    let reward = 0;
                    let msg = "";

                    if (chestCombo >= 6) {
                        if (yearBadgeEnabled) {
                            reward = Math.floor(Math.random() * (8 - 5 + 1)) + 5; // 5 to 8
                            msg = `👑 Gold Mystery Box! You found ${reward} 💎!`;
                        } else {
                            reward = Math.floor(Math.random() * (6 - 3 + 1)) + 3; // 3 to 6
                            msg = `🎁 Silver Mystery Box! You found ${reward} 💎!`;
                        }
                        chestCombo = 0;
                    } else {
                        if (yearBadgeEnabled) {
                            reward = 2;
                            chestCombo += 1;
                            msg = `🧰 Gold Chest Opened! +2 💎. Combo: ${chestCombo}/6`;
                        } else {
                            reward = 1;
                            chestCombo += 1;
                            msg = `🥈 Silver Chest Opened! +1 💎. Combo: ${chestCombo}/6`;
                        }
                    }

                    metaStore.put(gems + reward, "gems");
                    metaStore.put(now, "lastChestOpenDate");
                    metaStore.put(chestCombo, "chestCombo");

                    transaction.oncomplete = () => {
                        refreshTasks();
                        showToast(msg);
                    };
                }
            }
        }
    };
}

// #endregion

// #region 3: CORE QUEST LOGIC

// QUEST ENGINE & AUTOMATION
async function refreshTasks() {
    const transaction = db.transaction([TASK_STORE, META_STORE], "readwrite");
    const store = transaction.objectStore(TASK_STORE);
    const metaStore = transaction.objectStore(META_STORE);

    try {
        // 1. FETCH ALL DATA IN ONE FLAT BLOCK
        const gems = await dbGet(metaStore, "gems", 0);
        const globalFreezes = await dbGet(metaStore, "globalFreezes", 0);
        const activeCapacity = await dbGet(metaStore, "activeCapacity", 2);
        const trueMaxFreezes = await dbGet(metaStore, "trueMaxFreezes", 2);
        const lastChestOpenDate = await dbGet(metaStore, "lastChestOpenDate", 0);
        const chestCombo = await dbGet(metaStore, "chestCombo", 0);
        const chestEnabled = await dbGet(metaStore, "chestEnabled", false);
        const yearBadgeEnabled = await dbGet(metaStore, "yearBadgeEnabled", false);
        
        let lastStreakUpdate = await dbGet(metaStore, "lastStreakUpdate", 0);
        let globalStreak = await dbGet(metaStore, "globalStreak", 0);
        
        const tasks = await dbGetAll(store);

        // 2. RUN THE ENGINE
        const now = Date.now();
        let totalGemsEarned = 0;
        let freezesUsed = 0;
        let usableFreezes = Math.min(globalFreezes, activeCapacity);

        tasks.forEach(task => {
            if (task.isArchived) return;

            const isPending = task.startDate && now < task.startDate;

            if (isPending) {
                task.energyPercent = 100;
                return;
            }

            let timeLeft = task.deadline - now;
            const todayDay = new Date(now).setHours(0, 0, 0, 0);

            // --- UNIVERSAL MIDNIGHT SWEEPER ---
            if (task.completed && !task.gemClaimed && task.completedAt) {
                const completedDay = new Date(task.completedAt).setHours(0, 0, 0, 0);

                if (todayDay > completedDay) {
                    totalGemsEarned += 1;   
                    task.gemClaimed = true; 
                    
                    if (task.isOneTime) {
                        store.delete(task.id); 
                        showToast(`Bounty Cleared: ${task.name}! +1 💎`);
                        return; 
                    } else {
                        // Only award a gem here if it DOES NOT have subquests. Subquests reward on cycle reset!
                        if (!task.subQuests || task.subQuests.length === 0) {
                            totalGemsEarned += 1;   
                            task.gemClaimed = true; 
                            store.put(task); 
                            showToast(`Daily Reward: ${task.name}! +1 💎`);
                        }
                    }
                }
            }

            // --- ONE-TIME QUEST LOGIC ---
            if (task.isOneTime) {
                if (timeLeft <= 0 && !task.completed) {
                    task.isArchived = true;
                    task.energyPercent = 0;
                    store.put(task);
                    showToast(`Failed one-time quest: ${task.name}`);
                } else if (timeLeft > 0 && !task.completed) {
                    task.energyPercent = Math.max(0, Math.min(100, Math.round((timeLeft / task.durationMs) * 100)));
                }
                return; 
            }

            // --- RECURRING LOGIC ---
            if (task.hasLimit && now >= task.expireAt) {
                store.delete(task.id);
                return;
            }

            if (timeLeft <= 0) {
                const timeOverdue = now - task.deadline;
                const cyclesMissed = Math.floor(timeOverdue / task.durationMs) + 1;

                // --- NEW: REWARD AND REMOVE SUBQUESTS ON SCHEDULE RESET ---
                if (task.subQuests && task.subQuests.length > 0) {
                    const completedSubs = task.subQuests.filter(sq => sq.completed).length;
                    if (completedSubs > 0) {
                        totalGemsEarned += completedSubs; // +1 Gem per completed sub-quest!
                        // Erase the completed ones so the fresh card is clean
                        task.subQuests = task.subQuests.filter(sq => !sq.completed);
                        showToast(`Routine Cleared: ${task.name}! +${completedSubs} 💎`);
                    }
                }

                task.completed = false;
                task.gemClaimed = false; 
                task.completedAt = null;
                
                task.createdAt = task.createdAt + (cyclesMissed * task.durationMs);
                task.deadline = task.deadline + (cyclesMissed * task.durationMs);
                timeLeft = task.deadline - now;
                store.put(task);
            }

            if (timeLeft > 0 && !task.completed) {
                task.energyPercent = Math.max(0, Math.min(100, Math.round((timeLeft / task.durationMs) * 100)));
            }
        });

        // --- THE GLOBAL FREEZE ENGINE ---
        const todayDay = new Date(now).setHours(0, 0, 0, 0);
        const lastStreakDay = new Date(lastStreakUpdate).setHours(0, 0, 0, 0);
        const oneDay = 24 * 60 * 60 * 1000;

        if (lastStreakUpdate !== 0 && globalStreak > 0 && todayDay > lastStreakDay) {
            const daysPassed = Math.round((todayDay - lastStreakDay) / oneDay);
            
            if (daysPassed > 1) { 
                const daysMissed = daysPassed - 1;

                if (usableFreezes >= daysMissed) {
                    globalFreezes -= daysMissed;
                    freezesUsed += daysMissed;
                    lastStreakUpdate += (daysMissed * oneDay); 
                    metaStore.put(lastStreakUpdate, "lastStreakUpdate");
                } else {
                    globalStreak = 0;
                    globalFreezes -= usableFreezes; 
                    metaStore.put(0, "globalStreak");
                    showToast("💔 You missed a day. Global Streak broken.");
                }
            }
        }

        // 1. Save all updated metadata safely
            metaStore.put(gems + totalGemsEarned, "gems");
            metaStore.put(globalFreezes, "globalFreezes");
            metaStore.put(activeCapacity, "activeCapacity");
            metaStore.put(trueMaxFreezes, "trueMaxFreezes");

            // 2. Update UI Top Bar
            document.getElementById('gemCount').innerText = gems + totalGemsEarned;
            
            const highestStreak = globalStreak;
            const highestStreakEl = document.getElementById('highestStreak');
            if (highestStreakEl) highestStreakEl.innerText = highestStreak;

            // 3. Auto-Lock logic (Skill Tree)
            let stateChanged = false;
            if (highestStreak < 30 && chestEnabled) { chestEnabled = false; metaStore.put(false, "chestEnabled"); stateChanged = true; }
            if (highestStreak < 180 && trueMaxFreezes === 5) { trueMaxFreezes = 2; activeCapacity = 2; globalFreezes = Math.min(globalFreezes, 2); metaStore.put(2, "trueMaxFreezes"); metaStore.put(2, "activeCapacity"); metaStore.put(globalFreezes, "globalFreezes"); stateChanged = true; showToast("⚠️ Streak fell below 180. Freezes locked."); }
            if (highestStreak >= 180 && trueMaxFreezes === 2) { trueMaxFreezes = 5; globalFreezes += 3; metaStore.put(5, "trueMaxFreezes"); metaStore.put(globalFreezes, "globalFreezes"); stateChanged = true; showToast("🔥 180 Streak! Capacity expanded to 5."); }
            if (highestStreak < 365 && yearBadgeEnabled) { yearBadgeEnabled = false; metaStore.put(false, "yearBadgeEnabled"); stateChanged = true; }

            const badgeEl = document.getElementById('yearBadge');
            if (yearBadgeEnabled && badgeEl) {
                const years = Math.floor(highestStreak / 365);
                badgeEl.innerText = `${years}+`;
                badgeEl.classList.remove('hidden');
            } else if (badgeEl) {
                badgeEl.classList.add('hidden');
            }

            // 4. Chest UI
            const chestContainer = document.getElementById('floatingChestContainer');
            ['chestNormal', 'chestMystery', 'chestGold', 'chestGoldMystery'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.add('hidden');
            });

            const lastOpenDay = new Date(lastChestOpenDate).setHours(0, 0, 0, 0);
            if (chestEnabled && highestStreak > 0 && todayDay > lastOpenDay) {
                chestContainer.classList.remove('hidden');
                let displayCombo = (lastChestOpenDate !== 0 && (todayDay - lastOpenDay > oneDay)) ? 0 : chestCombo;
                const textId = yearBadgeEnabled ? 'chestGoldComboText' : 'chestComboText';
                const elText = document.getElementById(textId);
                if (elText) elText.innerText = `Combo: ${displayCombo}/6`;

                if (displayCombo >= 6) {
                    document.getElementById(yearBadgeEnabled ? 'chestGoldMystery' : 'chestMystery').classList.remove('hidden');
                } else {
                    document.getElementById(yearBadgeEnabled ? 'chestGold' : 'chestNormal').classList.remove('hidden');
                }
            } else {
                chestContainer.classList.add('hidden');
            }

            const shopGem = document.getElementById('shopGemCount');
            if (shopGem) {
                shopGem.innerText = gems + totalGemsEarned;
                document.getElementById('shopFreezeCount').innerText = globalFreezes;
                document.getElementById('shopMaxFreezes').innerText = trueMaxFreezes;
            }

            if (freezesUsed > 0) showToast(`Used ${freezesUsed} ❄️ to protect your Global Streak!`);

            // 5. Render Board
            const activeQuests = tasks.filter(t => !t.completed && !t.isArchived && !(t.startDate && now < t.startDate)).sort((a, b) => a.deadline - b.deadline);
            const comingQuests = tasks.filter(t => !t.completed && !t.isArchived && (t.startDate && now < t.startDate)).sort((a, b) => a.startDate - b.startDate);
            const finishedQuests = tasks.filter(t => t.completed && !t.isArchived).sort((a, b) => a.deadline - b.deadline);

            renderTaskCards(activeQuests, 'activeTasksList', 'No active quests for today.');
            renderTaskCards(comingQuests, 'comingTasksList', 'No upcoming quests.');
            renderTaskCards(finishedQuests, 'completedTasksList', 'No quests conquered yet.');
        } catch (error) {
        // The missing parachute!
        console.error("Critical Engine Failure:", error);
        showToast("System Error: Board failed to synchronize.");
    }
}

function saveTask() {
    const id = document.getElementById('editTaskId').value;
    const name = document.getElementById('taskName').value;
    const desc = document.getElementById('taskDesc').value;

    // --- START DATE LOGIC ---
    const startDateInput = document.getElementById('taskStartDate').value;
    let startDate;

    if (startDateInput) {
        startDate = new Date(startDateInput).getTime();
    } else {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        startDate = today.getTime();
    }

    // --- QUEST TYPE LOGIC ---
    const questTypeValue = document.getElementById('questType').value;
    const isOneTime = questTypeValue === 'onetime' || questTypeValue === 'folder'; 
    const isFolder = questTypeValue === 'folder';

    let freqNum = 1, freqUnit = 'weeks', displayFreq = '', durationMs = 0;
    let hasLimit = false, limitData = { type: null }, expireAt = null;
    let deadline;
    let oneTimeData = null; 
    let subQuests = [];

    // --- EXTRACT SUB-QUESTS FIRST ---
    if (questTypeValue === 'folder' || questTypeValue === 'recurring') {
        const inputs = document.querySelectorAll('.sub-quest-input');
        inputs.forEach(input => {
            if (input.value.trim() !== '') {
                subQuests.push({ name: input.value.trim(), completed: input.getAttribute('data-completed') === 'true' });
            }
        });
        if (isFolder && subQuests.length === 0) return showToast("Folders must have at least one sub-quest.");
    }

    if (isOneTime) {
        const otType = document.getElementById('oneTimeDeadlineType').value;
        if (otType === 'duration') {
            const num = parseInt(document.getElementById('oneTimeNum').value);
            const unit = document.getElementById('oneTimeUnit').value;
            if (isNaN(num) || num < 1) return showToast("Enter a valid duration.");

            let days = num;
            if (unit === 'weeks') days = num * 7;
            if (unit === 'months') days = num * 30;
            if (unit === 'years') days = num * 365;

            durationMs = days * 24 * 60 * 60 * 1000;
            deadline = startDate + durationMs;
            oneTimeData = { type: 'duration', num, unit };
        } else {
            const deadlineInput = document.getElementById('oneTimeDeadline').value;
            if (!deadlineInput) return showToast("Please set a hard deadline.");
            deadline = new Date(deadlineInput).getTime();

            if (deadline <= startDate) return showToast("Deadline must be after Start Date.");
            durationMs = deadline - startDate;
            oneTimeData = { type: 'date', dateStr: deadlineInput };
        }
        
        displayFreq = isFolder ? "📁 Quest Folder" : "One-Time Quest";
    } else {
        // --- RECURRING LOGIC ---
        freqNum = parseInt(document.getElementById('taskFreqNum').value);
        freqUnit = document.getElementById('taskFreqUnit').value;
        if (freqNum < 1 || isNaN(freqNum)) return showToast("Enter a valid frequency.");

        let days = freqNum;
        if (freqUnit === 'weeks') days = freqNum * 7;
        if (freqUnit === 'months') days = freqNum * 30;
        if (freqUnit === 'years') days = freqNum * 365;

        durationMs = days * 24 * 60 * 60 * 1000;
        const unitText = freqNum === 1 ? freqUnit.slice(0, -1) : freqUnit;
        displayFreq = `Every ${freqNum} ${unitText.charAt(0).toUpperCase() + unitText.slice(1)}`;
        deadline = startDate + durationMs;

        hasLimit = document.getElementById('taskHasLimit').checked;
        const limitType = document.getElementById('limitType').value;
        const limitNum = parseInt(document.getElementById('limitNum').value);
        const limitUnit = document.getElementById('limitUnit').value;
        const limitDateStr = document.getElementById('limitDate').value;
        const limitOccurrences = parseInt(document.getElementById('limitOccurrences').value);

        if (hasLimit) {
            if (limitType === 'duration') {
                let lDays = limitNum;
                if (limitUnit === 'weeks') lDays = limitNum * 7;
                if (limitUnit === 'months') lDays = limitNum * 30;
                if (limitUnit === 'years') lDays = limitNum * 365;
                expireAt = startDate + (lDays * 24 * 60 * 60 * 1000);
                limitData = { type: 'duration', num: limitNum, unit: limitUnit };
            } else if (limitType === 'date') {
                if (!limitDateStr) { showToast("Please select an end date and time."); return; }
                expireAt = new Date(limitDateStr).getTime();
                limitData = { type: 'date', dateStr: limitDateStr };
            } else if (limitType === 'occurrences') {
                if (isNaN(limitOccurrences) || limitOccurrences < 1) { showToast("Enter valid occurrences."); return; }
                expireAt = startDate + (limitOccurrences * durationMs);
                limitData = { type: 'occurrences', count: limitOccurrences };
            }
        }
    }

    if (!name) return showToast("Please enter a quest name.");

    const transaction = db.transaction([TASK_STORE], "readwrite");
    const store = transaction.objectStore(TASK_STORE);

    if (id !== '') {
        // --- EDITING ---
        store.get(parseInt(id)).onsuccess = (e) => {
            const task = e.target.result;
            task.name = name;
            task.desc = desc;
            task.startDate = startDate;
            task.isOneTime = isOneTime;
            task.freqNum = freqNum;
            task.freqUnit = freqUnit;
            task.displayFreq = displayFreq;
            task.durationMs = durationMs;
            task.deadline = deadline;
            task.hasLimit = hasLimit;
            task.limitData = limitData;
            task.expireAt = expireAt;
            task.oneTimeData = oneTimeData;

            const now = Date.now();
            const isPending = task.startDate && now < task.startDate;

            if (isPending) {
                task.energyPercent = 100;
            } else if (!task.completed) {
                const timeLeft = task.deadline - now;
                task.energyPercent = Math.max(0, Math.min(100, Math.round((timeLeft / task.durationMs) * 100)));
            }
            
            // Assign folder data BEFORE saving to the database
            task.isFolder = isFolder;
            task.subQuests = subQuests;

            store.put(task);
            transaction.oncomplete = () => {
                refreshTasks();
                closeTaskModal();
                showToast("Quest Updated!");
            };
        };
    } else {
        // --- ADDING NEW ---
        store.add({
            name, desc, isOneTime, freqNum, freqUnit, displayFreq, durationMs,
            hasLimit, limitData, expireAt, isFolder, subQuests,
            isArchived: false,
            startDate: startDate,
            createdAt: startDate,
            deadline: deadline,
            oneTimeData: oneTimeData,
            streak: 0, completed: false, energyPercent: 100
        });

        transaction.oncomplete = () => {
            refreshTasks();
            closeTaskModal();
            showToast("Quest Added!");
        };
    }
}

function toggleTask(id) {
    const transaction = db.transaction([TASK_STORE, META_STORE], "readwrite");
    const store = transaction.objectStore(TASK_STORE);
    const metaStore = transaction.objectStore(META_STORE);

    store.get(id).onsuccess = (e) => {
        const task = e.target.result;
        const now = Date.now();

        if (!task.completed) {
            task.completed = true;
            task.completedAt = now;
            task.gemClaimed = false; // Prep for the midnight sweep!

            const timeLeft = task.deadline - now;
            if (timeLeft > 0) {
                task.energyPercent = Math.max(0, Math.min(100, Math.round((timeLeft / task.durationMs) * 100)));
            }

            // --- GLOBAL STREAK ADD LOGIC ---
            metaStore.get("lastStreakUpdate").onsuccess = (eDate) => {
                let lastDate = eDate.target.result || 0;
                metaStore.get("globalStreak").onsuccess = (eStreak) => {
                    let globalStreak = eStreak.target.result || 0;

                    const todayDay = new Date(now).setHours(0, 0, 0, 0);
                    const lastStreakDay = new Date(lastDate).setHours(0, 0, 0, 0);

                    // If this is the FIRST task completed today, boost the streak!
                    if (lastDate === 0 || todayDay > lastStreakDay) {
                        globalStreak += 1;
                        metaStore.put(globalStreak, "globalStreak");
                        metaStore.put(now, "lastStreakUpdate");
                        showToast(`🔥 Daily Streak increased to ${globalStreak}!`);
                    }
                };
            };
        } else {
            task.completed = false;
            task.completedAt = null;
            task.gemClaimed = false;

            // --- GLOBAL STREAK UNDO LOGIC ---
            store.getAll().onsuccess = (eTasks) => {
                const allTasks = eTasks.target.result;
                const todayDay = new Date(now).setHours(0, 0, 0, 0);

                // Check if there are ANY OTHER tasks completed today
                const otherCompletedTasks = allTasks.some(t => 
                    t.id !== task.id && 
                    t.completed && 
                    t.completedAt && 
                    new Date(t.completedAt).setHours(0, 0, 0, 0) === todayDay
                );

                // If this was the ONLY task done today, revoke the streak!
                if (!otherCompletedTasks) {
                    metaStore.get("globalStreak").onsuccess = (eStreak) => {
                        let globalStreak = eStreak.target.result || 0;
                        if (globalStreak > 0) {
                            globalStreak -= 1;
                            metaStore.put(globalStreak, "globalStreak");
                            
                            // Roll the calendar back to yesterday so you don't get locked out of re-earning it
                            const yesterday = now - (24 * 60 * 60 * 1000);
                            metaStore.put(yesterday, "lastStreakUpdate");
                            showToast("Undo: Daily Streak reverted.");
                        }
                    };
                }
            };
        }

        store.put(task);
    };

    transaction.oncomplete = () => {
        refreshTasks();
        if (currentFolderViewId === id) renderFolderView();
    };
}

let taskIdToDelete = null;

function confirmDelete(id) {
    taskIdToDelete = id;
    document.getElementById('deleteModal').classList.remove('hidden');
}

function closeDeleteModal() {
    document.getElementById('deleteModal').classList.add('hidden');
}

document.getElementById('confirmDeleteBtn').addEventListener('click', () => {
    if (taskIdToDelete !== null) {
        const transaction = db.transaction([TASK_STORE], "readwrite");
        transaction.objectStore(TASK_STORE).delete(taskIdToDelete);
        transaction.oncomplete = () => {
            refreshTasks();
            closeDeleteModal();
            taskIdToDelete = null;
        };
    }
});

// #endregion

// #region 4: BOARD & RENDERER

function renderTaskCards(taskArray, containerId, emptyMessage) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    const now = Date.now();

    if (taskArray.length === 0) {
        container.innerHTML = `<div class="col-span-1 md:col-span-2 lg:col-span-3"><p class="text-muted text-sm text-center py-6 italic">${emptyMessage}</p></div>`;
        return;
    }

    taskArray.forEach((task) => {
        const isPending = task.startDate && now < task.startDate;
        // Check if this task is actively ticking down!
        const isDynamic = !task.completed && !isPending;

        const card = document.createElement('div');

        // Add dynamic targeting class
        card.className = `glass-card flex flex-col h-full rounded-[2rem] p-6 shadow-premium transition-all ${task.completed ? 'ring-2 ring-orange-400 bg-white/40 ring-inset' : ''} ${isPending ? 'opacity-75 grayscale-[0.2]' : ''} ${isDynamic ? 'dynamic-task-card' : ''}`;

        // Embed the math directly into the HTML element
        if (isDynamic) {
            card.setAttribute('data-deadline', task.deadline);
            card.setAttribute('data-duration', task.durationMs);
        }

        let barColor = 'bg-green-500';
        if (task.energyPercent <= 25) barColor = 'bg-red-500';
        if (task.completed || isPending) barColor = 'bg-gray-300';

        let btnAction, btnClass, btnText;
        if (isPending) {
            const startD = new Date(task.startDate);
            const dateStr = startD.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            // Add the exact time (e.g., 14:30)
            const timeStr = startD.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

            btnAction = '';
            btnClass = 'bg-gray-100 text-gray-400 cursor-not-allowed border border-gray-200';
            btnText = `⏳ Starts ${dateStr}, ${timeStr}`;
        } else {
            btnAction = `onclick="toggleTask(${task.id})"`;
            btnClass = task.completed ? 'bg-green-100 text-green-700 hover:bg-red-100 hover:text-red-600' : 'bg-gray-100 text-dark hover:bg-orange-50 hover:text-orange-600';
            btnText = task.completed ? '✓ Done (Undo)' : 'Complete';
        }

        card.innerHTML = `
            <div class="flex justify-between items-start mb-3 gap-4">
                <div class="flex-1 min-w-0">
                    <h3 class="text-lg font-bold text-dark leading-tight line-clamp-1">${task.name}</h3>
                    ${task.desc ? `<p class="text-xs text-muted mt-1 line-clamp-2">${task.desc}</p>` : ''}
                </div>
            </div>
            
            <div class="mt-auto space-y-4">
                <div>
                    <div class="flex justify-between items-end mb-1.5">
                        <span class="text-xs font-bold text-muted uppercase tracking-wider">${task.displayFreq}</span>
                        <span class="text-sm font-bold energy-text ${isPending ? 'text-gray-400' : (task.completed ? 'text-green-500' : 'text-orange-500')}">${isPending ? 'Locked' : (task.completed ? 'Safe at ' + task.energyPercent + '%' : task.energyPercent + '%')}</span>
                    </div>
                    <div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                        <div class="${barColor} h-2 rounded-full transition-all duration-1000 ease-out energy-bar" style="width: ${task.energyPercent}%"></div>
                    </div>
                </div>

            <div class="pt-2 flex items-center justify-between gap-2">
                <button ${btnAction} class="check-transition flex-grow flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm whitespace-nowrap ${btnClass}">
                    ${btnText}
                </button>
                
                <div class="flex gap-1 shrink-0 ml-2">
                    <button onclick="fetchAndEditTaskModal(${task.id})" class="p-3 rounded-xl bg-gray-50 text-muted hover:text-orange-500 hover:bg-orange-50 transition-all active:scale-90" title="Edit">✏️</button>
                    <button onclick="confirmDelete(${task.id})" class="p-3 rounded-xl bg-gray-50 text-muted hover:text-red-500 hover:bg-red-50 transition-all active:scale-90" title="Delete">🗑️</button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

setInterval(() => {
    const now = Date.now();
    const dynamicCards = document.querySelectorAll('.dynamic-task-card');

    dynamicCards.forEach(card => {
        const deadline = parseInt(card.getAttribute('data-deadline'));
        const duration = parseInt(card.getAttribute('data-duration'));

        const timeLeft = deadline - now;

        // If a quest expires while you are actively staring at the screen...
        // We trigger the main engine to burn a freeze and reset the board!
        if (timeLeft <= 0) {
            refreshTasks();
            return;
        }

        // Calculate the real-time fraction
        const percent = Math.max(0, Math.min(100, Math.round((timeLeft / duration) * 100)));

        const textEl = card.querySelector('.energy-text');
        const barEl = card.querySelector('.energy-bar');

        // Visually update the UI
        if (textEl) textEl.innerText = percent + '%';
        if (barEl) {
            barEl.style.width = percent + '%';

            // Turn the bar red if it drops to 25% while you're watching!
            if (percent <= 25 && barEl.classList.contains('bg-green-500')) {
                barEl.classList.remove('bg-green-500');
                barEl.classList.add('bg-red-500');
            }
        }
    });
}, 60000);

function switchTab(tabId) {
    // 1. Hide all tab panels
    document.getElementById('tab-active').classList.add('hidden');
    document.getElementById('tab-coming').classList.add('hidden');
    document.getElementById('tab-completed').classList.add('hidden');

    // 2. Show the selected panel
    document.getElementById(`tab-${tabId}`).classList.remove('hidden');

    // 3. Reset all nav buttons to default gray
    const baseNavClass = "flex-1 flex flex-col items-center gap-1 text-gray-400 hover:text-dark transition-all";
    document.getElementById('nav-active').className = baseNavClass;
    document.getElementById('nav-coming').className = baseNavClass;
    document.getElementById('nav-completed').className = baseNavClass;

    // 4. Highlight the active nav button with your primary color (Orange)
    document.getElementById(`nav-${tabId}`).className = "flex-1 flex flex-col items-center gap-1 text-orange-500 transition-all scale-105";
}

// #endregion

// #region 5: QUEST MODAL & FORMS

function openTaskModal() {
    document.getElementById('taskModal').classList.remove('hidden');
    document.getElementById('taskForm').reset();
    const ghostRow = document.getElementById('modalGhostRowInput');
    if (ghostRow) { ghostRow.value = ''; autoResize(ghostRow); }
    document.getElementById('taskDesc').style.height = 'auto';
    document.getElementById('editTaskId').value = '';
    document.getElementById('taskModalTitle').innerText = 'New Quest';

    // --- Reset the scrollbar to the top ---
    document.getElementById('taskForm').parentElement.scrollTop = 0;

    // --- Set default Start Date & Time to EXACTLY NOW ---
    const now = new Date();
    // We have to adjust for your local timezone (WIB), otherwise the browser uses UTC!
    const tzoffset = now.getTimezoneOffset() * 60000;
    const localISOTime = new Date(now.getTime() - tzoffset).toISOString().slice(0, 16);
    document.getElementById('taskStartDate').value = localISOTime;

    // Force the UI to match the freshly reset form
    toggleQuestType();
    toggleLimitType();
    setTimeout(() => {
        document.getElementById('taskName').focus();
    }, 50);
    if (typeof toggleOneTimeInputs === "function") toggleOneTimeInputs();
}

function closeTaskModal() {
    document.getElementById('taskModal').classList.add('hidden');
}

function fetchAndEditTaskModal(id) {
    const transaction = db.transaction([TASK_STORE], "readonly");
    const store = transaction.objectStore(TASK_STORE);

    store.get(id).onsuccess = (e) => {
        const task = e.target.result;

        document.getElementById('editTaskId').value = task.id;
        document.getElementById('taskModalTitle').innerText = 'Edit Quest';
        document.getElementById('taskName').value = task.name;
        document.getElementById('taskDesc').value = task.desc || '';

        // HELPER: Formats a timestamp into YYYY-MM-DDThh:mm for the HTML input
        const formatDateTimeLocal = (timestamp) => {
            const d = new Date(timestamp);
            const tzoffset = d.getTimezoneOffset() * 60000;
            return new Date(d.getTime() - tzoffset).toISOString().slice(0, 16);
        };

        // Load exact Start Date & Time
        if (task.startDate) {
            document.getElementById('taskStartDate').value = formatDateTimeLocal(task.startDate);
        } else {
            document.getElementById('taskStartDate').value = '';
        }

        // Handle Quest Type View & Sub-Quests
        if (task.isFolder) {
            document.getElementById('questType').value = 'folder';
        } else {
            document.getElementById('questType').value = task.isOneTime ? 'onetime' : 'recurring';
        }
        
        clearSubQuests();
        if (task.subQuests && task.subQuests.length > 0) {
            task.subQuests.forEach(sq => addSubQuestInput(sq.name, sq.completed));
        }
        
        toggleQuestType();

        if (task.isOneTime) {
            if (task.oneTimeData) {
                document.getElementById('oneTimeDeadlineType').value = task.oneTimeData.type;
                if (task.oneTimeData.type === 'duration') {
                    document.getElementById('oneTimeNum').value = task.oneTimeData.num || 1;
                    document.getElementById('oneTimeUnit').value = task.oneTimeData.unit || 'days';
                } else {
                    document.getElementById('oneTimeDeadline').value = formatDateTimeLocal(task.deadline);
                }
            } else {
                // Fallback for old quests made before this update
                document.getElementById('oneTimeDeadlineType').value = 'date';
                document.getElementById('oneTimeDeadline').value = formatDateTimeLocal(task.deadline);
            }
            toggleOneTimeInputs(); // Show the right boxes!
        } else {
            document.getElementById('taskFreqNum').value = task.freqNum || 1;
            document.getElementById('taskFreqUnit').value = task.freqUnit || 'weeks';

            // Load Limit Data...
            document.getElementById('taskHasLimit').checked = task.hasLimit || false;

            if (task.hasLimit && task.limitData) {
                document.getElementById('limitType').value = task.limitData.type || 'duration';

                if (task.limitData.type === 'duration') {
                    document.getElementById('limitNum').value = task.limitData.num || 1;
                    document.getElementById('limitUnit').value = task.limitData.unit || 'months';
                } else if (task.limitData.type === 'date') {
                    document.getElementById('limitDate').value = formatDateTimeLocal(task.expireAt);
                } else if (task.limitData.type === 'occurrences') {
                    document.getElementById('limitOccurrences').value = task.limitData.count || 10;
                }
            }
            toggleLimitType();
        }

        document.getElementById('taskModal').classList.remove('hidden');
        
        // Give the browser 10ms to paint the modal before measuring the text
        setTimeout(() => {
            autoResize(document.getElementById('taskDesc'));
        }, 10);
    };
}

function completeQuestFromModal() {
    if (!currentFolderViewId) return;
    toggleTask(currentFolderViewId); // Triggers the exact same logic as a dashboard Complete button
}

function addSubQuestInput(val = '', isCompleted = false, doFocus = false) {
    const container = document.getElementById('subQuestsList');
    const div = document.createElement('div');
    
    // Match the exact padding and layout of the Folder View
    div.className = 'flex items-start justify-between p-2 rounded-xl hover:bg-gray-50 transition-all border border-transparent hover:border-gray-100 group';

    // Safely format text and determine styling based on completion status
    const safeVal = val.replace(/"/g, '&quot;');
    const completedClass = isCompleted ? 'bg-orange-500 border-orange-500 text-white' : 'border-gray-300 group-hover:border-orange-400';
    const textClass = isCompleted ? 'text-gray-400 line-through' : 'text-dark';
    const checkOpacity = isCompleted ? 'opacity-100' : 'opacity-0';

    div.innerHTML = `
        <div class="flex items-start gap-3 flex-1 min-w-0 pt-0.5">
            <div class="w-6 h-6 shrink-0 rounded-full border-2 flex items-center justify-center cursor-pointer transition-all ${completedClass}" onclick="toggleModalSubQuest(this)">
                <svg class="w-4 h-4 ${checkOpacity} transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>
            </div>
            
            <textarea rows="1" placeholder="Quest name..." data-completed="${isCompleted}" 
                oninput="autoResize(this)" 
                onkeydown="if(event.key === 'Enter') { event.preventDefault(); const ghost = document.getElementById('modalGhostRowInput'); ghost.focus(); setTimeout(() => { const c = ghost.closest('.overflow-y-auto'); if(c) c.scrollTo({top: c.scrollHeight, behavior: 'smooth'}); }, 50); }"
                class="sub-quest-input flex-1 bg-transparent border-none p-0 focus:ring-0 resize-none overflow-hidden outline-none text-sm font-medium transition-all ${textClass}">${safeVal}</textarea>
        </div>
        
        <div class="flex gap-1 shrink-0 ml-2">
            <button type="button" onclick="this.closest('.group').remove()" class="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all active:scale-90" title="Remove">🗑️</button>
        </div>
    `;
    container.appendChild(div);

    const newTextarea = div.querySelector('textarea');
    setTimeout(() => {
        autoResize(newTextarea);
        if (doFocus) newTextarea.focus();
    }, 10);
}

function clearSubQuests() {
    document.getElementById('subQuestsList').innerHTML = '';
}

function toggleModalSubQuest(btn) {
    // Find the textarea sitting right next to this checkbox
    const textarea = btn.nextElementSibling;
    const isCompleted = textarea.getAttribute('data-completed') === 'true';
    const willBeCompleted = !isCompleted;

    // 1. Update the hidden data state so saveTask() sees it
    textarea.setAttribute('data-completed', willBeCompleted);

    // 2. Update Text Styling
    if (willBeCompleted) {
        textarea.classList.add('text-gray-400', 'line-through');
        textarea.classList.remove('text-dark');
    } else {
        textarea.classList.remove('text-gray-400', 'line-through');
        textarea.classList.add('text-dark');
    }

    // 3. Update Box Styling
    if (willBeCompleted) {
        btn.classList.add('bg-orange-500', 'border-orange-500', 'text-white');
        btn.classList.remove('border-gray-300', 'group-hover:border-orange-400');
    } else {
        btn.classList.remove('bg-orange-500', 'border-orange-500', 'text-white');
        btn.classList.add('border-gray-300', 'group-hover:border-orange-400');
    }

    // 4. Update SVG Checkmark
    const svg = btn.querySelector('svg');
    if (willBeCompleted) {
        svg.classList.add('opacity-100');
        svg.classList.remove('opacity-0');
    } else {
        svg.classList.remove('opacity-100');
        svg.classList.add('opacity-0');
    }
}

function toggleQuestType() {
    const type = document.getElementById('questType').value;
    document.getElementById('oneTimeSettings').classList.add('hidden');
    document.getElementById('recurringSettings').classList.add('hidden');
    document.getElementById('folderSettings').classList.add('hidden');

    if (type === 'onetime') {
        document.getElementById('oneTimeSettings').classList.remove('hidden');
    } else if (type === 'recurring') {
        document.getElementById('recurringSettings').classList.remove('hidden');
        document.getElementById('folderSettings').classList.remove('hidden'); // Show sub-quests
    } else if (type === 'folder') {
        document.getElementById('oneTimeSettings').classList.remove('hidden');
        document.getElementById('folderSettings').classList.remove('hidden');
    }
}

function toggleOneTimeInputs() {
    const type = document.getElementById('oneTimeDeadlineType').value;
    if (type === 'duration') {
        document.getElementById('oneTimeDurationInputs').classList.remove('hidden');
        document.getElementById('oneTimeDurationInputs').classList.add('flex');
        document.getElementById('oneTimeDateInputs').classList.add('hidden');
    } else {
        document.getElementById('oneTimeDurationInputs').classList.add('hidden');
        document.getElementById('oneTimeDurationInputs').classList.remove('flex');
        document.getElementById('oneTimeDateInputs').classList.remove('hidden');
    }
}

function toggleLimitType() {
    const isChecked = document.getElementById('taskHasLimit').checked;
    const container = document.getElementById('limitOptionsContainer');
    if (isChecked) {
        container.classList.remove('hidden');
        toggleLimitInputs(); // Trigger the sub-menu visibility
    } else {
        container.classList.add('hidden');
    }
}

function toggleLimitInputs() {
    const type = document.getElementById('limitType').value;

    // Hide all first
    document.getElementById('limitDurationInputs').classList.add('hidden');
    document.getElementById('limitDurationInputs').classList.remove('flex');

    document.getElementById('limitDateInputs').classList.add('hidden');
    document.getElementById('limitDateInputs').classList.remove('flex');

    document.getElementById('limitOccurrencesInputs').classList.add('hidden');
    document.getElementById('limitOccurrencesInputs').classList.remove('flex');

    // Show the selected one
    if (type === 'duration') {
        document.getElementById('limitDurationInputs').classList.remove('hidden');
        document.getElementById('limitDurationInputs').classList.add('flex');
    } else if (type === 'date') {
        document.getElementById('limitDateInputs').classList.remove('hidden');
        document.getElementById('limitDateInputs').classList.add('flex');
    } else if (type === 'occurrences') {
        document.getElementById('limitOccurrencesInputs').classList.remove('hidden');
        document.getElementById('limitOccurrencesInputs').classList.add('flex');
    }
}

function toggleSubQuest(taskId, subIndex) {
    const transaction = db.transaction([TASK_STORE, META_STORE], "readwrite");
    const store = transaction.objectStore(TASK_STORE);
    const metaStore = transaction.objectStore(META_STORE);

    store.get(taskId).onsuccess = (e) => {
        const task = e.target.result;
        const now = Date.now();

        // 1. Toggle the specific sub-quest
        const wasSubCompleted = task.subQuests[subIndex].completed;
        task.subQuests[subIndex].completed = !wasSubCompleted;

        // 2. Check Folder Status
        if (task.isFolder) {
            const allDone = task.subQuests.every(sq => sq.completed);
            const wasFolderCompleted = task.completed;
            task.completed = allDone;

            if (task.completed && !wasFolderCompleted) {
                task.completedAt = now;
                task.gemClaimed = false; // Midnight sweeper will delete it and grant gem
                showToast(`📁 Folder Cleared: ${task.name}!`);
            } else if (!task.completed && wasFolderCompleted) {
                task.completedAt = null;
                task.gemClaimed = false;
            }
        }

        // 3. Global Streak Logic
        // Completing ANY sub-quest counts as effort for the day!
        if (task.subQuests[subIndex].completed) {
            metaStore.get("lastStreakUpdate").onsuccess = (eDate) => {
                let lastDate = eDate.target.result || 0;
                metaStore.get("globalStreak").onsuccess = (eStreak) => {
                    let globalStreak = eStreak.target.result || 0;
                    const todayDay = new Date(now).setHours(0, 0, 0, 0);
                    const lastStreakDay = new Date(lastDate).setHours(0, 0, 0, 0);

                    if (lastDate === 0 || todayDay > lastStreakDay) {
                        globalStreak += 1;
                        metaStore.put(globalStreak, "globalStreak");
                        metaStore.put(now, "lastStreakUpdate");
                        showToast(`🔥 Daily Streak increased! Sub-quest done!`);
                    }
                };
            };
        } else {
            // Unchecking a sub-quest triggers the undo scanner
            store.getAll().onsuccess = (eTasks) => {
                const allTasks = eTasks.target.result;
                const todayDay = new Date(now).setHours(0, 0, 0, 0);

                // Look for any other completed tasks OR completed subquests today
                const otherProgress = allTasks.some(t => {
                    if (t.id === task.id) {
                        // Check remaining subquests in THIS folder
                        return t.subQuests && t.subQuests.some(sq => sq.completed); 
                    }
                    return t.completed && t.completedAt && new Date(t.completedAt).setHours(0, 0, 0, 0) === todayDay;
                });

                if (!otherProgress) {
                    metaStore.get("globalStreak").onsuccess = (eStreak) => {
                        let globalStreak = eStreak.target.result || 0;
                        if (globalStreak > 0) {
                            globalStreak -= 1;
                            metaStore.put(globalStreak, "globalStreak");
                            const yesterday = now - (24 * 60 * 60 * 1000);
                            metaStore.put(yesterday, "lastStreakUpdate");
                            showToast("Undo: Daily Streak reverted.");
                        }
                    };
                }
            };
        }

        store.put(task);
    };

    transaction.oncomplete = () => {
        refreshTasks(); // Update the main board in the background
        if (currentFolderViewId === taskId) {
            renderFolderView(); // Instantly update the checkboxes in the open modal
        }
    };
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    // Ensure you fix the mojibake emojis if they pop up here too!
    document.getElementById('toastMsg').innerText = msg;
    toast.classList.remove('opacity-0', 'translate-y-4');
    toast.classList.add('opacity-100', 'translate-y-0');
    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-4');
        toast.classList.remove('opacity-100', 'translate-y-0');
    }, 3000);
}

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeTaskModal();
        closeDeleteModal();
        closeSettings();
        closeShopModal();
        closeFolderViewModal();
    }
});

// #endregion

// #region 6: MENUS, SETTINGS & SKILL TREE

function openSettings() {
    document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettings() {
    document.getElementById('settingsModal').classList.add('hidden');
}

async function exportData() {
    const transaction = db.transaction([TASK_STORE, META_STORE], "readonly");
    const taskStore = transaction.objectStore(TASK_STORE);
    const metaStore = transaction.objectStore(META_STORE);

    try {
        const backup = {
            tasks: await dbGetAll(taskStore),
            metadata: {
                gems: await dbGet(metaStore, "gems", 0),
                globalFreezes: await dbGet(metaStore, "globalFreezes", 0),
                activeCapacity: await dbGet(metaStore, "activeCapacity", 2),
                trueMaxFreezes: await dbGet(metaStore, "trueMaxFreezes", 2),
                lastFreezeRecharge: await dbGet(metaStore, "lastFreezeRecharge", null),
                chestCombo: await dbGet(metaStore, "chestCombo", 0),
                lastChestOpenDate: await dbGet(metaStore, "lastChestOpenDate", null),
                chestEnabled: await dbGet(metaStore, "chestEnabled", false),
                yearBadgeEnabled: await dbGet(metaStore, "yearBadgeEnabled", false),
                globalStreak: await dbGet(metaStore, "globalStreak", 0),
                lastStreakUpdate: await dbGet(metaStore, "lastStreakUpdate", 0)
            }
        };

        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        
        const now = new Date();
        const tzoffset = now.getTimezoneOffset() * 60000;
        const localTime = new Date(now.getTime() - tzoffset).toISOString().slice(0, 19).replace('T', " at ").replace(/:/g, '-');

        a.download = `Game of Life ${localTime}.json`;
        a.click();
        showToast("Save file downloaded successfully!");
        
    } catch (error) {
        console.error("Export failed:", error);
        showToast("Error creating backup.");
    }
}

function importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.tasks) throw new Error("Invalid format");

            const transaction = db.transaction([TASK_STORE, META_STORE], "readwrite");
            const taskStore = transaction.objectStore(TASK_STORE);
            const metaStore = transaction.objectStore(META_STORE);

            taskStore.clear();
            data.tasks.forEach(task => taskStore.add(task));

            // Restore all critical metadata pieces
            if (data.metadata?.gems !== undefined) metaStore.put(data.metadata.gems, "gems");
            if (data.metadata?.globalFreezes !== undefined) metaStore.put(data.metadata.globalFreezes, "globalFreezes");
            if (data.metadata?.activeCapacity !== undefined) metaStore.put(data.metadata.activeCapacity, "activeCapacity");
            if (data.metadata?.trueMaxFreezes !== undefined) metaStore.put(data.metadata.trueMaxFreezes, "trueMaxFreezes");
            if (data.metadata?.lastFreezeRecharge !== undefined) metaStore.put(data.metadata.lastFreezeRecharge, "lastFreezeRecharge");
            if (data.metadata?.chestCombo !== undefined) metaStore.put(data.metadata.chestCombo, "chestCombo");
            if (data.metadata?.lastChestOpenDate !== undefined) metaStore.put(data.metadata.lastChestOpenDate, "lastChestOpenDate");
            if (data.metadata?.chestEnabled !== undefined) metaStore.put(data.metadata.chestEnabled, "chestEnabled");
            if (data.metadata?.yearBadgeEnabled !== undefined) metaStore.put(data.metadata.yearBadgeEnabled, "yearBadgeEnabled");
            if (data.metadata?.globalStreak !== undefined) metaStore.put(data.metadata.globalStreak, "globalStreak");
            if (data.metadata?.lastStreakUpdate !== undefined) metaStore.put(data.metadata.lastStreakUpdate, "lastStreakUpdate");


            transaction.oncomplete = () => {
                showToast("Game state restored successfully!");
                refreshTasks();
            };
        } catch (err) {
            showToast("Error: Corrupted save file.");
            console.error(err);
        }
    };
    reader.readAsText(file);
}

function openShopModal() {
    document.getElementById('shopModal').classList.remove('hidden');
}

function closeShopModal() {
    document.getElementById('shopModal').classList.add('hidden');
}

function openStreakModal() {
    const transaction = db.transaction([META_STORE], "readonly");
    const metaStore = transaction.objectStore(META_STORE);

    // Fetch the new Global Streak instead of checking individual tasks
    metaStore.get("globalStreak").onsuccess = (eStreak) => {
        const highestStreak = eStreak.target.result || 0;

        metaStore.get("chestEnabled").onsuccess = (e1) => {
            const chestEnabled = e1.target.result || false;
            metaStore.get("activeCapacity").onsuccess = (e2) => {
                const activeCap = e2.target.result || 2;
                metaStore.get("yearBadgeEnabled").onsuccess = (e3) => {
                    const yearBadgeEnabled = e3.target.result || false;

                    const container = document.getElementById('streakTogglesContainer');
                    container.innerHTML = ''; // Clear out old

                    // Helper to generate toggles dynamically
                    const createToggle = (id, icon, title, req, isUnlocked, isChecked, colorClass) => {
                        return `
                <div class="p-4 rounded-2xl ${isUnlocked ? `bg-${colorClass}-50 border border-${colorClass}-100` : 'bg-gray-50 border border-gray-100 grayscale opacity-60'} flex items-center justify-between transition-all">
                    <div class="flex items-center gap-4">
                        <div class="w-10 h-10 rounded-xl bg-white border border-gray-200 flex items-center justify-center shadow-sm text-lg">${icon}</div>
                        <div>
                            <p class="text-sm font-bold text-dark leading-tight">${title}</p>
                            <p class="text-[10px] uppercase font-bold tracking-wider ${isUnlocked ? `text-${colorClass}-600` : 'text-gray-400'}">${isUnlocked ? 'Unlocked!' : `Locked: ${req}+ Streak`}</p>
                        </div>
                    </div>
                    <label class="relative inline-flex items-center ${isUnlocked ? 'cursor-pointer' : 'cursor-not-allowed'} ml-4 shrink-0">
                        <input type="checkbox" onchange="toggleFeature('${id}', this.checked)" class="sr-only peer" ${isChecked ? 'checked' : ''} ${isUnlocked ? '' : 'disabled'}>
                        <div class="w-11 h-6 bg-gray-300 rounded-full peer peer-checked:bg-primary peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                    </label>
                </div>`;
                    };

                    container.innerHTML += createToggle('chest', '📦', 'Silver Chests', 30, highestStreak >= 30, chestEnabled, 'blue');
                    container.innerHTML += createToggle('capacity', '❄️', 'Extra Freezes', 180, highestStreak >= 180, activeCap === 5, 'blue');
                    container.innerHTML += createToggle('badge', '👑', 'Year Badge & Gold', 365, highestStreak >= 365, yearBadgeEnabled, 'yellow');

                    document.getElementById('streakModal').classList.remove('hidden');
                };
            };
        };
    };
}

function closeStreakModal() {
    document.getElementById('streakModal').classList.add('hidden');
}

function toggleFeature(feature, isChecked) {
    const transaction = db.transaction([META_STORE], "readwrite");
    const metaStore = transaction.objectStore(META_STORE);

    if (feature === 'chest') metaStore.put(isChecked, "chestEnabled");
    if (feature === 'capacity') metaStore.put(isChecked ? 5 : 2, "activeCapacity");
    if (feature === 'badge') metaStore.put(isChecked, "yearBadgeEnabled");

    transaction.oncomplete = () => refreshTasks(); // Apply UI changes instantly
}

// #endregion
