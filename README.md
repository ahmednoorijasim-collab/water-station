# محطة الماء المركزية

تطبيق أندرويد لمحطة توزيع الماء: المشترك يطلب إعادة تعبئة، والإدارة تخصص الطلبات للسيارات، والسيارة تتبع المسار وتسجل التعبئة.

- قاعدة البيانات وتسجيل الدخول: Firebase (Firestore + Authentication).
- قواعد الحماية: `firestore.rules` (تنلصق بصفحة Firestore ← Rules).
- البناء: GitHub Actions يبني ملف APK وينشره بصفحة Releases.

صنعه: Eng. Ahmed Noori
