const form = document.getElementById("registerForm");

const message = document.getElementById("message");


form.addEventListener("submit", async (event) => {

    event.preventDefault();


    message.textContent = "Creating account...";


    const username =
        document.getElementById("username").value.trim();

    const password =
        document.getElementById("password").value;

    const confirmPassword =
        document.getElementById("confirmPassword").value;

    const email =
        document.getElementById("email").value.trim();


    try {

        const response = await fetch("/api/register", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({

                username,
                password,
                confirmPassword,
                email

            })

        });


        const result = await response.json();


        if (!response.ok) {

            message.textContent =
                result.message || "Registration failed.";

            return;

        }


        message.textContent =
            result.message || "Account created successfully.";


        form.reset();


    } catch (error) {

        console.error(error);

        message.textContent =
            "Unable to contact the server.";

    }

});
