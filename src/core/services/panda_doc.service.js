//PANDADOC API
const createPandaDocDocument = async (booking, product, user) => {
    const url = 'https://api.pandadoc.com/public/v1/documents';

    const documentData = {
        name: `Contract for ${product.name} Booking`,
        template_uuid: env.PANDA_DOC_TEST_TEMPLATE_UUID,
        recipients: [
            {
                email: product.user == null ? product.store.email : product.user.email,
                role: 'Lender',
            },
            {
                email: user.email,
                role: 'Renter',
            },
        ],
        tokens: [
            { name: 'product.name', value: product.name },
            { name: 'booking.shortCode', value: booking.shortCode },
            { name: 'booking.quantity', value: booking.quantity },
            { name: 'booking.dateAndTime', value: convertTimestampToReadableFormat(booking.pickupTime) },
            { name: 'booking.returnDateAndTime', value: convertTimestampToReadableFormat(booking.dropOffTime) },
            { name: 'booking.totalAmount', value: `$${booking.totalAmount}` },
            { name: 'lender.name', value: product.user == null ? product.store.name : product.user.name },
            { name: 'renter.name', value: user.name },
        ]
    };

    try {
        const response = await axios.post(url, documentData, {
            headers: {
                'Authorization': `API-Key ${env.PANDA_DOC_PROD_API_KEY}`,
                'Content-Type': 'application/json',
            },
        });

        return response.data;
    } catch (error) {
        console.error('Error creating PandaDoc document:', error.message);
        return null;
    }
};

const sendPandaDocDocument = async (documentId) => {
    const url = `https://api.pandadoc.com/public/v1/documents/${documentId}/send`;

    const documentData = {
        message: "This document was sent from the Rentibles.",
    };

    try {
        const response = await axios.post(url, documentData, {
            headers: {
                'Authorization': `API-Key ${env.PANDA_DOC_PROD_API_KEY}`,
                'Content-Type': 'application/json',
            },
        });

        return response.data;
    } catch (error) {
        console.error('Error sending PandaDoc document:', error.message);
        return null;
    }
};

const handlePandaDocWebhook = async (data) => {
    const { id: documentId, action_by, recipients } = data;
    const signerEmail = action_by?.email;

    if (!documentId || !signerEmail) {
        console.error('Invalid webhook data. Document ID or signer email is missing.');
        return;
    }

    try {
        const booking = await BookingModel.findOne({ documentId });

        if (!booking) {
            console.error(`Booking not found for document ID: ${documentId}`);
            return;
        }

        const isSeller =
            (booking.store && recipients.some((recipient) => recipient.email === signerEmail)) ||
            (booking.user && recipients.some((recipient) => recipient.email === signerEmail));

        const isRenter = booking.customer && recipients.some((recipient) => recipient.email === signerEmail);

        if (isSeller) {
            booking.signedBySeller = true;
        } else if (isRenter) {
            booking.signedByRenter = true;
        } else {
            console.error(`Signer email ${signerEmail} does not match the seller or renter.`);
            return;
        }

        if (booking.signedBySeller && booking.signedByRenter) {
            booking.isContractSigned = true;
        }

        await booking.save();

        console.log(`Booking updated successfully for document ID: ${documentId}`);
    } catch (error) {
        console.error('Error handling PandaDoc webhook:', error.message);
    }
};

const completePandaDocContract = async (data) => {
    const { id: documentId } = data;

    if (!documentId) {
        console.error('Invalid webhook data. Document ID is missing.');
        return;
    }

    try {
        const booking = await BookingModel.findOne({ documentId });

        if (!booking) {
            console.error(`Booking not found for document ID: ${documentId}`);
            return;
        }

        booking.isContractSigned = true;

        await booking.save();

        console.log(`Booking updated successfully for document ID: ${documentId}`);
    } catch (error) {
        console.error('Error handling PandaDoc webhook:', error.message);
    }
};