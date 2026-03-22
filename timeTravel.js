// --- DEBUG: TIME TRAVEL (FAST FORWARD 1 DAY) ---
function timeTravel() {
    const transaction = db.transaction([TASK_STORE, META_STORE], "readwrite");
    const taskStore = transaction.objectStore(TASK_STORE);
    const metaStore = transaction.objectStore(META_STORE);
    const oneDay = 24 * 60 * 60 * 1000;

    // 1. Shift Tasks back by 1 day
    taskStore.getAll().onsuccess = (e) => {
        const tasks = e.target.result;
        tasks.forEach(task => {
            if (task.deadline) task.deadline -= oneDay;
            if (task.completedAt) task.completedAt -= oneDay;
            if (task.startDate) task.startDate -= oneDay;
            if (task.createdAt) task.createdAt -= oneDay;
            if (task.expireAt) task.expireAt -= oneDay;
            taskStore.put(task);
        });
    };

    // 2. Shift Metadata back by 1 day
    metaStore.get("lastStreakUpdate").onsuccess = (e) => {
        let lastDate = e.target.result || 0;
        if (lastDate !== 0) metaStore.put(lastDate - oneDay, "lastStreakUpdate");
    };

    metaStore.get("lastChestOpenDate").onsuccess = (e) => {
        let lastChest = e.target.result || 0;
        if (lastChest !== 0) metaStore.put(lastChest - oneDay, "lastChestOpenDate");
    };

    metaStore.get("lastFreezeRecharge").onsuccess = (e) => {
        let lastRecharge = e.target.result || 0;
        if (lastRecharge !== 0) metaStore.put(lastRecharge - oneDay, "lastFreezeRecharge");
    };

    transaction.oncomplete = () => {
        showToast("⏳ Time Travel Successful: 1 Day has passed.");
        refreshTasks();
    };
}